#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#else
#error "Hush install helper supports only macOS and Linux"
#endif

#if \
  !defined(O_CLOEXEC) \
  || !defined(O_DIRECTORY) \
  || !defined(O_NOFOLLOW) \
  || !defined(F_DUPFD_CLOEXEC) \
  || !defined(AT_SYMLINK_NOFOLLOW) \
  || !defined(AT_REMOVEDIR)
#error "Hush install helper requires no-follow directory descriptor support"
#endif

enum {
  SOURCE_FD = 3,
  RUNTIME_PARENT_FD = 4,
  BIN_FD = 5,
  GUARDED_SOURCE_FD = 10,
  GUARDED_RUNTIME_PARENT_FD = 11,
  GUARDED_BIN_FD = 12,
};

static const char *stage_marker = ".hush-stage-owner";
static const char *manifest_name = ".hush-runtime-manifest.json";

struct object_identity {
  dev_t device;
  ino_t inode;
};

static _Noreturn void fail(const char *format, ...) {
  va_list args;
  fprintf(stderr, "hush install helper: ");
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fputc('\n', stderr);
  exit(1);
}

static void fail_errno(const char *action, const char *path) {
  fail("%s %s: %s", action, path, strerror(errno));
}

static bool same_inode(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static bool same_file_state(const struct stat *left, const struct stat *right) {
  if (!same_inode(left, right) || left->st_size != right->st_size) return false;
#if defined(__APPLE__)
  return left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec
    && left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec
    && left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec
    && left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
#else
  return left->st_mtim.tv_sec == right->st_mtim.tv_sec
    && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
    && left->st_ctim.tv_sec == right->st_ctim.tv_sec
    && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
#endif
}

static struct object_identity identity_from_stat(const struct stat *metadata) {
  return (struct object_identity){
    .device = metadata->st_dev,
    .inode = metadata->st_ino,
  };
}

static uintmax_t parse_identity_part(const char *value, const char *label, int base) {
  if (!value || !value[0] || value[0] == '-') fail("invalid %s identity: %s", label, value ? value : "(null)");
  errno = 0;
  char *end = NULL;
  uintmax_t parsed = strtoumax(value, &end, base);
  if (errno || !end || *end) fail("invalid %s identity: %s", label, value);
  return parsed;
}

static struct object_identity parse_identity(const char *device, const char *inode) {
  uintmax_t parsed_device = parse_identity_part(device, "device", 10);
  uintmax_t parsed_inode = parse_identity_part(inode, "inode", 10);
  struct object_identity result = {
    .device = (dev_t)parsed_device,
    .inode = (ino_t)parsed_inode,
  };
  if ((uintmax_t)result.device != parsed_device || (uintmax_t)result.inode != parsed_inode) {
    fail("managed object identity is out of range");
  }
  return result;
}

static bool parse_optional_identity(
  const char *device,
  const char *inode,
  struct object_identity *result
) {
  bool no_device = strcmp(device, "-") == 0;
  bool no_inode = strcmp(inode, "-") == 0;
  if (no_device != no_inode) fail("managed object identity must provide both device and inode");
  if (no_device) return false;
  *result = parse_identity(device, inode);
  return true;
}

static bool matches_identity(const struct stat *metadata, const struct object_identity *expected) {
  return metadata->st_dev == expected->device && metadata->st_ino == expected->inode;
}

static void require_identity(
  const struct stat *metadata,
  const struct object_identity *expected,
  const char *label
) {
  if (!matches_identity(metadata, expected)) fail("%s changed during install", label);
}

static void print_identity(const struct stat *metadata) {
  printf("%ju\t%ju\n", (uintmax_t)metadata->st_dev, (uintmax_t)metadata->st_ino);
}

static int duplicate_fd(int fd) {
  int result = fcntl(fd, F_DUPFD_CLOEXEC, 20);
  if (result < 0) fail_errno("cannot duplicate descriptor for", "installer");
  return result;
}

static int reopen_directory(int fd) {
  int result = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (result < 0) fail_errno("cannot reopen descriptor for", "directory enumeration");
  return result;
}

static bool directory_contains(int ancestor_fd, int descendant_fd) {
  struct stat ancestor;
  if (fstat(ancestor_fd, &ancestor) < 0) fail_errno("cannot inspect", "directory ancestry");
  int current = duplicate_fd(descendant_fd);
  for (;;) {
    struct stat current_metadata;
    if (fstat(current, &current_metadata) < 0) fail_errno("cannot inspect", "directory ancestry");
    if (same_inode(&ancestor, &current_metadata)) {
      close(current);
      return true;
    }
    int parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) fail_errno("cannot traverse", "directory ancestry");
    struct stat parent_metadata;
    if (fstat(parent, &parent_metadata) < 0) fail_errno("cannot inspect", "directory ancestry");
    if (same_inode(&current_metadata, &parent_metadata)) {
      close(parent);
      close(current);
      return false;
    }
    close(current);
    current = parent;
  }
}

static void require_disjoint_directories(
  int left_fd,
  const char *left_label,
  int right_fd,
  const char *right_label
) {
  if (
    directory_contains(left_fd, right_fd)
    || directory_contains(right_fd, left_fd)
  ) {
    fail(
      "HUSH_INSTALL_ROOT_OVERLAP: physical %s and %s directory ancestry overlaps",
      left_label,
      right_label
    );
  }
}

static void pause_for_test(const char *point, const char *entry_name) {
  const char *requested = getenv("HUSH_INSTALL_TEST_PAUSE_AT");
  if (!requested || strcmp(requested, point) != 0) return;
  const char *requested_entry = getenv("HUSH_INSTALL_TEST_PAUSE_ENTRY");
  if (requested_entry && (!entry_name || strcmp(requested_entry, entry_name) != 0)) return;
  const char *marker = getenv("HUSH_INSTALL_TEST_PAUSE_MARKER");
  const char *release = getenv("HUSH_INSTALL_TEST_PAUSE_RELEASE");
  if (!marker || !release) fail("test pause requires marker and release paths");

  int marker_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker_fd < 0) fail_errno("cannot create test pause marker", marker);
  char contents[64];
  int count = snprintf(contents, sizeof(contents), "%ld\n", (long)getpid());
  if (count < 0 || (size_t)count >= sizeof(contents)) fail("cannot format test pause marker");
  if (write(marker_fd, contents, (size_t)count) != count || close(marker_fd) < 0) {
    fail_errno("cannot write test pause marker", marker);
  }

  const struct timespec delay = {
    .tv_sec = 0,
    .tv_nsec = 20 * 1000 * 1000,
  };
  while (access(release, F_OK) < 0) {
    if (errno != ENOENT) fail_errno("cannot inspect test pause release", release);
    nanosleep(&delay, NULL);
  }
}

static void require_component(const char *name) {
  if (!name[0] || strchr(name, '/') || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    fail("unsafe path component: %s", name);
  }
  for (const unsigned char *cursor = (const unsigned char *)name; *cursor; cursor++) {
    if (*cursor < 0x20 || *cursor == 0x7f) fail("unsafe path component: %s", name);
  }
}

static char *next_component(char **cursor) {
  char *start = *cursor;
  while (*start == '/') start++;
  if (!*start) {
    *cursor = start;
    return NULL;
  }
  char *end = start;
  while (*end && *end != '/') end++;
  if (*end) *end++ = '\0';
  *cursor = end;
  require_component(start);
  return start;
}

static int open_absolute_directory(const char *path, bool create, mode_t mode) {
  if (!path || path[0] != '/') fail("directory path must be absolute: %s", path ? path : "(null)");
  char *copy = strdup(path);
  if (!copy) fail_errno("cannot allocate path for", path);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) fail_errno("cannot open", "/");

  char *cursor = copy;
  char *component;
  while ((component = next_component(&cursor)) != NULL) {
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && create && errno == ENOENT) {
      if (mkdirat(current, component, mode) < 0 && errno != EEXIST) {
        fail_errno("cannot create directory", component);
      }
      next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next < 0) fail_errno("directory is missing, symlinked, or not a directory:", path);
    close(current);
    current = next;
  }

  free(copy);
  return current;
}

static int open_relative_directory(int base_fd, const char *path, bool create, mode_t mode) {
  if (!path || !path[0] || path[0] == '/') fail("relative directory path required: %s", path ? path : "(null)");
  char *copy = strdup(path);
  if (!copy) fail_errno("cannot allocate path for", path);
  int current = duplicate_fd(base_fd);
  char *cursor = copy;
  char *component;
  while ((component = next_component(&cursor)) != NULL) {
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && create && errno == ENOENT) {
      if (mkdirat(current, component, mode) < 0 && errno != EEXIST) {
        fail_errno("cannot create directory", component);
      }
      next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next < 0) fail_errno("directory is missing, symlinked, or not a directory:", path);
    close(current);
    current = next;
  }
  free(copy);
  return current;
}

static int open_relative_parent(
  int base_fd,
  const char *path,
  bool create,
  mode_t mode,
  char **leaf_out
) {
  if (!path || !path[0] || path[0] == '/') fail("relative path required: %s", path ? path : "(null)");
  char *copy = strdup(path);
  if (!copy) fail_errno("cannot allocate path for", path);
  char *slash = strrchr(copy, '/');
  char *leaf = slash ? slash + 1 : copy;
  require_component(leaf);

  int parent;
  if (slash) {
    *slash = '\0';
    parent = open_relative_directory(base_fd, copy, create, mode);
  } else {
    parent = duplicate_fd(base_fd);
  }
  *leaf_out = strdup(leaf);
  if (!*leaf_out) fail_errno("cannot allocate leaf for", path);
  free(copy);
  return parent;
}

static void require_bound_directory(const char *path, int expected_fd, const char *label) {
  int actual_fd = open_absolute_directory(path, false, 0);
  struct stat expected;
  struct stat actual;
  if (fstat(expected_fd, &expected) < 0 || fstat(actual_fd, &actual) < 0) {
    fail_errno("cannot inspect bound directory", label);
  }
  close(actual_fd);
  if (!same_inode(&expected, &actual)) fail("%s path changed during install: %s", label, path);
}

static void lock_directory(int directory_fd) {
  if (flock(directory_fd, LOCK_EX | LOCK_NB) < 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) fail("another Hush install is already in progress");
    fail_errno("cannot lock", "managed directory");
  }
}

static void move_fd(int source, int target) {
  if (source != target && dup2(source, target) < 0) fail_errno("cannot bind descriptor for", "installer");
  int flags = fcntl(target, F_GETFD);
  if (flags < 0 || fcntl(target, F_SETFD, flags & ~FD_CLOEXEC) < 0) {
    fail_errno("cannot preserve descriptor for", "installer");
  }
}

static int rename_noreplace(int from_fd, const char *from, int to_fd, const char *to) {
#if defined(__APPLE__)
  return renameatx_np(from_fd, from, to_fd, to, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, from_fd, from, to_fd, to, RENAME_NOREPLACE);
#else
  errno = ENOTSUP;
  return -1;
#endif
}

static void copy_bytes(int source_fd, int destination_fd, const char *path) {
  char buffer[64 * 1024];
  for (;;) {
    ssize_t count = read(source_fd, buffer, sizeof(buffer));
    if (count < 0) fail_errno("cannot read staged input", path);
    if (count == 0) break;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(destination_fd, buffer + offset, (size_t)(count - offset));
      if (written < 0) fail_errno("cannot write staged input", path);
      offset += written;
    }
  }
}

static void copy_regular_at(
  int source_parent,
  const char *source_name,
  int destination_parent,
  const char *destination_name,
  const char *display_path
) {
  int source = openat(source_parent, source_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail_errno("source input is missing or symlinked:", display_path);
  struct stat source_metadata;
  if (fstat(source, &source_metadata) < 0) fail_errno("cannot inspect source input", display_path);
  if (!S_ISREG(source_metadata.st_mode)) fail("source input is not a regular file: %s", display_path);

  int destination = openat(
    destination_parent,
    destination_name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    source_metadata.st_mode & 0777
  );
  if (destination < 0) fail_errno("cannot create staged input", display_path);
  copy_bytes(source, destination, display_path);
  if (fchmod(destination, source_metadata.st_mode & 0777) < 0 || fsync(destination) < 0) {
    fail_errno("cannot finalize staged input", display_path);
  }
  struct stat final_source_metadata;
  if (fstat(source, &final_source_metadata) < 0) fail_errno("cannot recheck source input", display_path);
  if (!same_file_state(&source_metadata, &final_source_metadata)) {
    fail("source input changed while staging: %s", display_path);
  }
  struct stat destination_metadata;
  if (fstat(destination, &destination_metadata) < 0) fail_errno("cannot inspect staged input", display_path);
  if (destination_metadata.st_nlink != 1) fail("staged input unexpectedly has multiple hardlinks: %s", display_path);
  close(source);
  close(destination);
}

static void copy_tree_fds(int source_fd, int destination_fd, const char *display_path) {
  DIR *directory = fdopendir(reopen_directory(source_fd));
  if (!directory) fail_errno("cannot enumerate source directory", display_path);
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat metadata;
    if (fstatat(source_fd, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      fail_errno("cannot inspect source input", entry->d_name);
    }
    if (S_ISLNK(metadata.st_mode)) fail("source input symlink is forbidden: %s/%s", display_path, entry->d_name);
    if (S_ISDIR(metadata.st_mode)) {
      if (mkdirat(destination_fd, entry->d_name, metadata.st_mode & 0777) < 0) {
        fail_errno("cannot create staged directory", entry->d_name);
      }
      int source_child = openat(
        source_fd,
        entry->d_name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      );
      int destination_child = openat(
        destination_fd,
        entry->d_name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      );
      if (source_child < 0 || destination_child < 0) {
        fail_errno("source input ancestor changed while staging", entry->d_name);
      }
      struct stat opened_metadata;
      if (fstat(source_child, &opened_metadata) < 0) {
        fail_errno("cannot inspect opened source directory", entry->d_name);
      }
      if (!same_inode(&metadata, &opened_metadata)) {
        fail("source input ancestor changed while staging: %s/%s", display_path, entry->d_name);
      }
      char *child_path = NULL;
      if (asprintf(&child_path, "%s/%s", display_path, entry->d_name) < 0) {
        fail_errno("cannot allocate staged path for", entry->d_name);
      }
      copy_tree_fds(source_child, destination_child, child_path);
      if (fchmod(destination_child, metadata.st_mode & 0777) < 0 || fsync(destination_child) < 0) {
        fail_errno("cannot finalize staged directory", child_path);
      }
      free(child_path);
      close(source_child);
      close(destination_child);
    } else if (S_ISREG(metadata.st_mode)) {
      copy_regular_at(source_fd, entry->d_name, destination_fd, entry->d_name, display_path);
    } else {
      fail("source input type is unsupported: %s/%s", display_path, entry->d_name);
    }
  }
  closedir(directory);
}

static void copy_relative_file(int source_base, int destination_base, const char *path) {
  char *source_leaf = NULL;
  char *destination_leaf = NULL;
  int source_parent = open_relative_parent(source_base, path, false, 0, &source_leaf);
  int destination_parent = open_relative_parent(destination_base, path, true, 0755, &destination_leaf);
  copy_regular_at(source_parent, source_leaf, destination_parent, destination_leaf, path);
  if (fsync(destination_parent) < 0) fail_errno("cannot sync staged parent for", path);
  close(source_parent);
  close(destination_parent);
  free(source_leaf);
  free(destination_leaf);
}

static void copy_relative_tree(int source_base, int destination_base, const char *path) {
  char *source_leaf = NULL;
  char *destination_leaf = NULL;
  int source_parent = open_relative_parent(source_base, path, false, 0, &source_leaf);
  int destination_parent = open_relative_parent(destination_base, path, true, 0755, &destination_leaf);
  int source = openat(source_parent, source_leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail_errno("source input ancestor is symlinked or not a directory:", path);
  struct stat metadata;
  if (fstat(source, &metadata) < 0) fail_errno("cannot inspect source directory", path);
  if (mkdirat(destination_parent, destination_leaf, metadata.st_mode & 0777) < 0) {
    fail_errno("cannot create staged directory", path);
  }
  int destination = openat(
    destination_parent,
    destination_leaf,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (destination < 0) fail_errno("cannot open staged directory", path);
  copy_tree_fds(source, destination, path);
  if (fchmod(destination, metadata.st_mode & 0777) < 0 || fsync(destination) < 0) {
    fail_errno("cannot finalize staged directory", path);
  }
  close(source);
  close(destination);
  close(source_parent);
  close(destination_parent);
  free(source_leaf);
  free(destination_leaf);
}

static void write_small_file(int directory_fd, const char *name, const char *contents, mode_t mode) {
  int fd = openat(directory_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) fail_errno("cannot create", name);
  size_t length = strlen(contents);
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, contents + offset, length - offset);
    if (written < 0) fail_errno("cannot write", name);
    if (written == 0) fail("cannot write %s: zero-byte write", name);
    offset += (size_t)written;
  }
  if (fchmod(fd, mode) < 0 || fsync(fd) < 0) {
    fail_errno("cannot finalize", name);
  }
  close(fd);
}

static void require_regular_marker(int directory_fd, const char *name) {
  int fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail_errno("managed directory marker is missing or symlinked:", name);
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) fail_errno("cannot inspect managed directory marker", name);
  close(fd);
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
    fail("managed directory marker must be a single-link regular file: %s", name);
  }
}

static void format_stage_marker(
  char *buffer,
  size_t size,
  const struct object_identity *identity
) {
  int count = snprintf(
    buffer,
    size,
    "hush-stage-v2\t%ju\t%ju\n",
    (uintmax_t)identity->device,
    (uintmax_t)identity->inode
  );
  if (count < 0 || (size_t)count >= size) fail("cannot format Hush stage marker");
}

static void require_stage_marker(
  int directory_fd,
  const struct object_identity *expected
) {
  int fd = openat(directory_fd, stage_marker, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail_errno("Hush stage marker is missing or symlinked:", stage_marker);
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) fail_errno("cannot inspect Hush stage marker", stage_marker);
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1 || (metadata.st_mode & 0777) != 0400) {
    fail("Hush stage marker must be a read-only single-link regular file");
  }

  char actual[128];
  ssize_t count = read(fd, actual, sizeof(actual) - 1);
  if (count < 0) fail_errno("cannot read Hush stage marker", stage_marker);
  char extra;
  if (read(fd, &extra, 1) != 0) fail("Hush stage marker is invalid");
  close(fd);
  actual[count] = '\0';

  char expected_contents[128];
  format_stage_marker(expected_contents, sizeof(expected_contents), expected);
  if (strcmp(actual, expected_contents) != 0) fail("Hush stage marker identity mismatch");
}

static bool directory_is_empty(int directory_fd) {
  DIR *directory = fdopendir(reopen_directory(directory_fd));
  if (!directory) fail_errno("cannot enumerate", "managed directory");
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    closedir(directory);
    return false;
  }
  closedir(directory);
  return true;
}

static void remove_directory_contents(int directory_fd, const char *preserve_name) {
  DIR *directory = fdopendir(reopen_directory(directory_fd));
  if (!directory) fail_errno("cannot enumerate", "managed directory");
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (preserve_name && strcmp(entry->d_name, preserve_name) == 0) continue;
    struct stat metadata;
    if (fstatat(directory_fd, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      fail_errno("cannot inspect managed entry", entry->d_name);
    }
    if (S_ISDIR(metadata.st_mode)) {
      int child = openat(
        directory_fd,
        entry->d_name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      );
      if (child < 0) fail_errno("managed directory changed before removal:", entry->d_name);
      struct stat opened_metadata;
      if (fstat(child, &opened_metadata) < 0) {
        fail_errno("cannot inspect opened managed directory", entry->d_name);
      }
      if (!same_inode(&metadata, &opened_metadata)) {
        fail("managed directory changed before removal: %s", entry->d_name);
      }
      remove_directory_contents(child, NULL);
      struct stat current_metadata;
      if (fstatat(directory_fd, entry->d_name, &current_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
        fail_errno("managed directory changed before removal:", entry->d_name);
      }
      if (!same_inode(&opened_metadata, &current_metadata)) {
        fail("managed directory changed before removal: %s", entry->d_name);
      }
      close(child);
      if (unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR) < 0) {
        fail_errno("cannot remove managed directory", entry->d_name);
      }
    } else if (S_ISREG(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
      pause_for_test("before-managed-entry-unlink", entry->d_name);
      struct stat current_metadata;
      if (fstatat(directory_fd, entry->d_name, &current_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
        fail_errno("managed entry changed before removal:", entry->d_name);
      }
      if (!same_inode(&metadata, &current_metadata)) {
        fail("managed entry changed before removal: %s", entry->d_name);
      }
      if (unlinkat(directory_fd, entry->d_name, 0) < 0) {
        fail_errno("cannot remove managed entry", entry->d_name);
      }
    } else {
      fail("managed directory contains unsupported file type: %s", entry->d_name);
    }
  }
  closedir(directory);
}

static void remove_named_tree(
  int parent_fd,
  const char *name,
  bool stage,
  const struct object_identity *expected
) {
  require_component(name);
  int directory = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) fail_errno("managed directory is missing, symlinked, or not a directory:", name);
  struct stat directory_metadata;
  if (fstat(directory, &directory_metadata) < 0) {
    fail_errno("cannot inspect managed directory", name);
  }
  require_identity(&directory_metadata, expected, "managed directory");
  const char *marker = stage ? stage_marker : manifest_name;
  int marker_fd = openat(directory, marker, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (marker_fd < 0) {
    if (errno != ENOENT) {
      fail_errno("managed directory marker is missing or symlinked:", marker);
    }
    if (!directory_is_empty(directory)) fail("managed directory marker is missing: %s", marker);
  } else {
    struct stat metadata;
    if (fstat(marker_fd, &metadata) < 0) {
      fail_errno("cannot inspect managed directory marker", marker);
    }
    close(marker_fd);
    if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
      fail("managed directory marker must be a single-link regular file: %s", marker);
    }
    if (stage) require_stage_marker(directory, expected);
    remove_directory_contents(directory, marker);
    if (unlinkat(directory, marker, 0) < 0 || fsync(directory) < 0) {
      fail_errno("cannot finalize managed directory removal", name);
    }
  }
  struct stat current_metadata;
  if (fstatat(parent_fd, name, &current_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
    fail_errno("managed directory changed before removal:", name);
  }
  if (!same_inode(&directory_metadata, &current_metadata)) {
    fail("managed directory changed before removal: %s", name);
  }
  pause_for_test("before-managed-directory-unlink", name);
  if (fstatat(parent_fd, name, &current_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
    fail_errno("managed directory changed before removal:", name);
  }
  if (!same_inode(&directory_metadata, &current_metadata)) {
    fail("managed directory changed before removal: %s", name);
  }
  close(directory);
  if (unlinkat(parent_fd, name, AT_REMOVEDIR) < 0) fail_errno("cannot remove managed directory", name);
  if (fsync(parent_fd) < 0) fail_errno("cannot sync managed directory after removing", name);
}

static bool is_hex_runtime(const char *name) {
  if (strlen(name) != 40) return false;
  for (const char *cursor = name; *cursor; cursor++) {
    if (!((*cursor >= '0' && *cursor <= '9') || (*cursor >= 'a' && *cursor <= 'f'))) return false;
  }
  return true;
}

static bool has_prefix(const char *value, const char *prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

static struct object_identity prune_identity_from_name(const char *name) {
  const char *prefix = ".hush-prune-";
  if (!has_prefix(name, prefix)) fail("invalid Hush prune name: %s", name);
  const char *cursor = name + strlen(prefix);
  errno = 0;
  char *end = NULL;
  uintmax_t device = strtoumax(cursor, &end, 16);
  if (errno || end == cursor || *end != '-') fail("invalid Hush prune identity: %s", name);
  cursor = end + 1;
  errno = 0;
  uintmax_t inode = strtoumax(cursor, &end, 16);
  if (errno || end == cursor || *end != '-') fail("invalid Hush prune identity: %s", name);
  if (!end[1]) fail("invalid Hush prune name: %s", name);

  struct object_identity result = {
    .device = (dev_t)device,
    .inode = (ino_t)inode,
  };
  if ((uintmax_t)result.device != device || (uintmax_t)result.inode != inode) {
    fail("Hush prune identity is out of range: %s", name);
  }
  return result;
}

static struct object_identity launcher_quarantine_identity_from_name(const char *name) {
  const char *prefix = ".hush-bin-prune-";
  if (!has_prefix(name, prefix)) fail("invalid Hush launcher quarantine name: %s", name);
  const char *cursor = name + strlen(prefix);
  errno = 0;
  char *end = NULL;
  uintmax_t device = strtoumax(cursor, &end, 16);
  if (errno || end == cursor || *end != '-') fail("invalid Hush launcher quarantine identity: %s", name);
  cursor = end + 1;
  errno = 0;
  uintmax_t inode = strtoumax(cursor, &end, 16);
  if (errno || end == cursor || *end != '-') fail("invalid Hush launcher quarantine identity: %s", name);
  if (!end[1]) fail("invalid Hush launcher quarantine name: %s", name);

  struct object_identity result = {
    .device = (dev_t)device,
    .inode = (ino_t)inode,
  };
  if ((uintmax_t)result.device != device || (uintmax_t)result.inode != inode) {
    fail("Hush launcher quarantine identity is out of range: %s", name);
  }
  return result;
}

static void command_guard(int argc, char **argv) {
  if (argc < 8) fail("usage: guard <install|check> <source> <runtime-parent> <bin> <command> [args...]");
  bool create;
  if (strcmp(argv[2], "install") == 0) create = true;
  else if (strcmp(argv[2], "check") == 0) create = false;
  else fail("unknown guard mode: %s", argv[2]);
  int source = open_absolute_directory(argv[3], false, 0);
  int runtime_parent = open_absolute_directory(argv[4], create, 0700);
  int bin = open_absolute_directory(argv[5], create, 0755);
  require_disjoint_directories(source, "source", runtime_parent, "runtime parent");
  require_disjoint_directories(source, "source", bin, "bin");
  require_disjoint_directories(runtime_parent, "runtime parent", bin, "bin");
  lock_directory(runtime_parent);
  struct stat runtime_metadata;
  struct stat bin_metadata;
  if (fstat(runtime_parent, &runtime_metadata) < 0 || fstat(bin, &bin_metadata) < 0) {
    fail_errno("cannot inspect managed directory", "installer");
  }
  if (!same_inode(&runtime_metadata, &bin_metadata)) lock_directory(bin);

  move_fd(source, GUARDED_SOURCE_FD);
  move_fd(runtime_parent, GUARDED_RUNTIME_PARENT_FD);
  move_fd(bin, GUARDED_BIN_FD);
  setenv("HUSH_INSTALL_NATIVE_GUARDED", "1", 1);
  execvp(argv[6], &argv[6]);
  fail_errno("cannot exec guarded installer command", argv[6]);
}

static void command_check_roots(int argc, char **argv) {
  if (argc != 5) fail("usage: check-roots <source> <runtime-parent> <bin>");
  require_bound_directory(argv[2], SOURCE_FD, "Hush source root");
  require_bound_directory(argv[3], RUNTIME_PARENT_FD, "Hush runtime parent");
  require_bound_directory(argv[4], BIN_FD, "Hush bin root");
}

static void command_stage(int argc, char **argv) {
  if (argc < 6) fail("usage: stage <source> <runtime-parent> <stage-name> <f:path|t:path>...");
  require_bound_directory(argv[2], SOURCE_FD, "Hush source root");
  require_bound_directory(argv[3], RUNTIME_PARENT_FD, "Hush runtime parent");
  lock_directory(RUNTIME_PARENT_FD);
  const char *stage_name = argv[4];
  require_component(stage_name);
  if (!has_prefix(stage_name, ".hush-stage-")) fail("invalid Hush stage name: %s", stage_name);
  if (mkdirat(RUNTIME_PARENT_FD, stage_name, 0700) < 0) fail_errno("cannot create Hush stage", stage_name);
  int stage = openat(
    RUNTIME_PARENT_FD,
    stage_name,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (stage < 0) fail_errno("cannot open Hush stage", stage_name);
  struct stat stage_metadata;
  if (fstat(stage, &stage_metadata) < 0) fail_errno("cannot inspect Hush stage", stage_name);
  struct object_identity stage_identity = identity_from_stat(&stage_metadata);
  char marker_contents[128];
  format_stage_marker(marker_contents, sizeof(marker_contents), &stage_identity);
  write_small_file(stage, stage_marker, marker_contents, 0400);

  for (int index = 5; index < argc; index++) {
    if (strncmp(argv[index], "f:", 2) == 0) {
      copy_relative_file(SOURCE_FD, stage, argv[index] + 2);
    } else if (strncmp(argv[index], "t:", 2) == 0) {
      copy_relative_tree(SOURCE_FD, stage, argv[index] + 2);
    } else {
      fail("unknown staged input kind: %s", argv[index]);
    }
  }
  if (fsync(stage) < 0 || fsync(RUNTIME_PARENT_FD) < 0) fail_errno("cannot sync Hush stage", stage_name);
  close(stage);
  require_bound_directory(argv[2], SOURCE_FD, "Hush source root");
  require_bound_directory(argv[3], RUNTIME_PARENT_FD, "Hush runtime parent");
  print_identity(&stage_metadata);
}

static void command_entry_kind(int argc, char **argv) {
  if (argc != 4) fail("usage: entry-kind <runtime-parent> <name>");
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
  require_component(argv[3]);
  struct stat metadata;
  if (fstatat(RUNTIME_PARENT_FD, argv[3], &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
    if (errno == ENOENT) {
      puts("missing");
      return;
    }
    fail_errno("cannot inspect runtime entry", argv[3]);
  }
  const char *kind;
  if (S_ISDIR(metadata.st_mode)) kind = "directory";
  else if (S_ISLNK(metadata.st_mode)) kind = "symlink";
  else if (S_ISREG(metadata.st_mode)) kind = "file";
  else kind = "other";
  printf("%s\t%ju\t%ju\n", kind, (uintmax_t)metadata.st_dev, (uintmax_t)metadata.st_ino);
}

static void command_run_at(int argc, char **argv) {
  if (argc < 8) {
    fail("usage: run-at <source|runtime> <bound-path> <name-or-dash> <dev-or-dash> <ino-or-dash> <command> [args...]");
  }
  int directory = -1;
  if (strcmp(argv[2], "source") == 0) {
    require_bound_directory(argv[3], SOURCE_FD, "Hush source root");
    if (strcmp(argv[4], "-") != 0 || strcmp(argv[5], "-") != 0 || strcmp(argv[6], "-") != 0) {
      fail("source run-at does not accept a managed object identity");
    }
    directory = duplicate_fd(SOURCE_FD);
  } else if (strcmp(argv[2], "runtime") == 0) {
    require_bound_directory(argv[3], RUNTIME_PARENT_FD, "Hush runtime parent");
    require_component(argv[4]);
    struct object_identity expected;
    bool has_expected = parse_optional_identity(argv[5], argv[6], &expected);
    if (!has_expected) fail("runtime run-at requires a managed object identity");
    directory = openat(
      RUNTIME_PARENT_FD,
      argv[4],
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    );
    if (directory < 0) fail_errno("runtime is missing, symlinked, or not a directory:", argv[4]);
    struct stat metadata;
    if (fstat(directory, &metadata) < 0) fail_errno("cannot inspect guarded runtime", argv[4]);
    require_identity(&metadata, &expected, "guarded runtime");
    if (has_prefix(argv[4], ".hush-stage-")) require_stage_marker(directory, &expected);
  } else {
    fail("unknown run-at scope: %s", argv[2]);
  }
  if (fchdir(directory) < 0) fail_errno("cannot enter guarded directory", argv[3]);
  close(directory);
  move_fd(SOURCE_FD, GUARDED_SOURCE_FD);
  move_fd(RUNTIME_PARENT_FD, GUARDED_RUNTIME_PARENT_FD);
  move_fd(BIN_FD, GUARDED_BIN_FD);
  int command_index = 7;
  execvp(argv[command_index], &argv[command_index]);
  fail_errno("cannot exec guarded command", argv[command_index]);
}

static void command_publish_runtime(int argc, char **argv) {
  if (argc != 7) {
    fail("usage: publish-runtime <runtime-parent> <stage-name> <runtime-name> <dev> <ino>");
  }
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
  lock_directory(RUNTIME_PARENT_FD);
  require_component(argv[3]);
  require_component(argv[4]);
  struct object_identity expected = parse_identity(argv[5], argv[6]);
  int stage = openat(
    RUNTIME_PARENT_FD,
    argv[3],
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (stage < 0) fail_errno("Hush stage is missing, symlinked, or not a directory:", argv[3]);
  struct stat stage_metadata;
  if (fstat(stage, &stage_metadata) < 0) fail_errno("cannot inspect Hush stage", argv[3]);
  require_identity(&stage_metadata, &expected, "Hush stage");
  require_stage_marker(stage, &expected);
  int manifest = openat(stage, manifest_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (manifest < 0) fail_errno("managed directory marker is missing or symlinked:", manifest_name);
  struct stat manifest_metadata;
  if (fstat(manifest, &manifest_metadata) < 0) {
    fail_errno("cannot inspect managed directory marker", manifest_name);
  }
  if (!S_ISREG(manifest_metadata.st_mode) || manifest_metadata.st_nlink != 1) {
    fail("managed directory marker must be a single-link regular file: %s", manifest_name);
  }
  if (fsync(manifest) < 0 || close(manifest) < 0 || fsync(stage) < 0) {
    fail_errno("cannot sync finalized Hush stage", argv[3]);
  }
  if (rename_noreplace(RUNTIME_PARENT_FD, argv[3], RUNTIME_PARENT_FD, argv[4]) < 0) {
    fail_errno("cannot publish immutable Hush runtime", argv[4]);
  }
  pause_for_test("after-runtime-rename", argv[4]);
  int published = openat(
    RUNTIME_PARENT_FD,
    argv[4],
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (published < 0) fail_errno("published Hush runtime is missing or changed:", argv[4]);
  struct stat published_metadata;
  if (fstat(published, &published_metadata) < 0) {
    fail_errno("cannot inspect published Hush runtime", argv[4]);
  }
  if (!same_inode(&stage_metadata, &published_metadata)) {
    fail("published Hush runtime changed during publication: %s", argv[4]);
  }
  close(published);
  close(stage);
  if (fsync(RUNTIME_PARENT_FD) < 0) fail_errno("cannot sync published Hush runtime", argv[4]);
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
}

static void command_list_runtimes(int argc, char **argv) {
  if (argc != 3) fail("usage: list-runtimes <runtime-parent>");
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
  DIR *directory = fdopendir(reopen_directory(RUNTIME_PARENT_FD));
  if (!directory) fail_errno("cannot enumerate", argv[2]);
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (
      !is_hex_runtime(entry->d_name)
      && !has_prefix(entry->d_name, ".hush-stage-")
      && !has_prefix(entry->d_name, ".hush-prune-")
    ) {
      continue;
    }
    require_component(entry->d_name);
    struct stat metadata;
    if (fstatat(RUNTIME_PARENT_FD, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      fail_errno("cannot inspect managed runtime entry", entry->d_name);
    }
    char kind = 'X';
    if (S_ISDIR(metadata.st_mode)) {
      if (is_hex_runtime(entry->d_name)) kind = 'R';
      else if (has_prefix(entry->d_name, ".hush-stage-")) kind = 'S';
      else kind = 'P';
    }
#if defined(__APPLE__)
    long nanoseconds = metadata.st_mtimespec.tv_nsec;
    long long seconds = (long long)metadata.st_mtimespec.tv_sec;
#else
    long nanoseconds = metadata.st_mtim.tv_nsec;
    long long seconds = (long long)metadata.st_mtim.tv_sec;
#endif
    printf(
      "%c\t%lld\t%ld\t%ju\t%ju\t%s\n",
      kind,
      seconds,
      nanoseconds,
      (uintmax_t)metadata.st_dev,
      (uintmax_t)metadata.st_ino,
      entry->d_name
    );
  }
  closedir(directory);
}

static void command_remove_stale(int argc, char **argv) {
  if (argc != 6) fail("usage: remove-stale <runtime-parent> <name> <dev> <ino>");
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
  lock_directory(RUNTIME_PARENT_FD);
  bool stage = has_prefix(argv[3], ".hush-stage-");
  if (!stage && !has_prefix(argv[3], ".hush-prune-")) fail("invalid stale runtime name: %s", argv[3]);
  struct object_identity expected = parse_identity(argv[4], argv[5]);
  if (!stage) {
    struct object_identity encoded = prune_identity_from_name(argv[3]);
    if (encoded.device != expected.device || encoded.inode != expected.inode) {
      fail("Hush prune quarantine identity mismatch: %s", argv[3]);
    }
  }
  remove_named_tree(RUNTIME_PARENT_FD, argv[3], stage, &expected);
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
}

static void command_prune_runtime(int argc, char **argv) {
  if (argc != 6) fail("usage: prune-runtime <runtime-parent> <name> <dev> <ino>");
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
  lock_directory(RUNTIME_PARENT_FD);
  if (!is_hex_runtime(argv[3])) fail("invalid runtime name for pruning: %s", argv[3]);
  struct object_identity expected = parse_identity(argv[4], argv[5]);
  int runtime = openat(
    RUNTIME_PARENT_FD,
    argv[3],
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (runtime < 0) fail_errno("runtime is missing, symlinked, or not a directory:", argv[3]);
  struct stat runtime_metadata;
  if (fstat(runtime, &runtime_metadata) < 0) fail_errno("cannot inspect runtime for pruning", argv[3]);
  require_identity(&runtime_metadata, &expected, "runtime selected for pruning");
  require_regular_marker(runtime, manifest_name);

  char quarantine[192];
  bool renamed = false;
  for (int attempt = 0; attempt < 100; attempt++) {
    int count = snprintf(
      quarantine,
      sizeof(quarantine),
      ".hush-prune-%jx-%jx-%ld-%d",
      (uintmax_t)expected.device,
      (uintmax_t)expected.inode,
      (long)getpid(),
      attempt
    );
    if (count < 0 || (size_t)count >= sizeof(quarantine)) {
      fail("cannot format quarantine name for runtime: %s", argv[3]);
    }
    if (rename_noreplace(RUNTIME_PARENT_FD, argv[3], RUNTIME_PARENT_FD, quarantine) == 0) {
      renamed = true;
      break;
    }
    if (errno != EEXIST) fail_errno("cannot quarantine Hush runtime", argv[3]);
  }
  if (!renamed) fail("cannot allocate quarantine name for runtime: %s", argv[3]);
  int quarantined = openat(
    RUNTIME_PARENT_FD,
    quarantine,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (quarantined < 0) fail_errno("quarantined Hush runtime is missing or changed:", quarantine);
  struct stat quarantined_metadata;
  if (fstat(quarantined, &quarantined_metadata) < 0) {
    fail_errno("cannot inspect quarantined Hush runtime", quarantine);
  }
  if (!same_inode(&runtime_metadata, &quarantined_metadata)) {
    fail("quarantined Hush runtime changed during pruning: %s", argv[3]);
  }
  close(quarantined);
  close(runtime);
  if (fsync(RUNTIME_PARENT_FD) < 0) fail_errno("cannot sync quarantined runtime", argv[3]);
  remove_named_tree(RUNTIME_PARENT_FD, quarantine, false, &expected);
  require_bound_directory(argv[2], RUNTIME_PARENT_FD, "Hush runtime parent");
}

static void command_cleanup_bin(int argc, char **argv) {
  if (argc != 3) fail("usage: cleanup-bin <bin>");
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
  lock_directory(BIN_FD);
  DIR *directory = fdopendir(reopen_directory(BIN_FD));
  if (!directory) fail_errno("cannot enumerate", argv[2]);
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    bool quarantined = has_prefix(entry->d_name, ".hush-bin-prune-");
    if (!quarantined && !has_prefix(entry->d_name, ".hush-launcher-")) continue;
    require_component(entry->d_name);
    struct stat metadata;
    if (fstatat(BIN_FD, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      if (errno == ENOENT) continue;
      fail_errno("cannot inspect stale launcher", entry->d_name);
    }
    if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
      fail("stale launcher must be a single-link regular file: %s", entry->d_name);
    }
    int opened = openat(BIN_FD, entry->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (opened < 0) fail_errno("stale launcher changed before cleanup:", entry->d_name);
    struct stat opened_metadata;
    if (fstat(opened, &opened_metadata) < 0) fail_errno("cannot inspect opened stale launcher", entry->d_name);
    if (!same_inode(&metadata, &opened_metadata)) {
      fail("stale launcher changed before cleanup: %s", entry->d_name);
    }

    struct object_identity expected = identity_from_stat(&opened_metadata);
    char quarantine[192];
    const char *cleanup_name = entry->d_name;
    if (quarantined) {
      struct object_identity encoded = launcher_quarantine_identity_from_name(entry->d_name);
      if (encoded.device != expected.device || encoded.inode != expected.inode) {
        fail("Hush launcher quarantine identity mismatch: %s", entry->d_name);
      }
    } else {
      pause_for_test("before-launcher-quarantine", entry->d_name);
      bool renamed = false;
      for (int attempt = 0; attempt < 100; attempt++) {
        int count = snprintf(
          quarantine,
          sizeof(quarantine),
          ".hush-bin-prune-%jx-%jx-%ld-%d",
          (uintmax_t)expected.device,
          (uintmax_t)expected.inode,
          (long)getpid(),
          attempt
        );
        if (count < 0 || (size_t)count >= sizeof(quarantine)) {
          fail("cannot format launcher quarantine name: %s", entry->d_name);
        }
        if (rename_noreplace(BIN_FD, entry->d_name, BIN_FD, quarantine) == 0) {
          renamed = true;
          break;
        }
        if (errno != EEXIST) fail_errno("cannot quarantine stale launcher", entry->d_name);
      }
      if (!renamed) fail("cannot allocate launcher quarantine name: %s", entry->d_name);
      if (fsync(BIN_FD) < 0) fail_errno("cannot sync quarantined stale launcher", entry->d_name);
      cleanup_name = quarantine;
    }

    struct stat cleanup_metadata;
    if (fstatat(BIN_FD, cleanup_name, &cleanup_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      fail_errno("quarantined stale launcher is missing or changed:", cleanup_name);
    }
    if (!matches_identity(&cleanup_metadata, &expected)) {
      close(opened);
      fail("quarantined stale launcher changed during cleanup: %s", cleanup_name);
    }
    if (unlinkat(BIN_FD, cleanup_name, 0) < 0) fail_errno("cannot remove quarantined stale launcher", cleanup_name);
    close(opened);
  }
  closedir(directory);
  if (fsync(BIN_FD) < 0) fail_errno("cannot sync", argv[2]);
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
}

static void command_write_launcher(int argc, char **argv) {
  if (argc != 6) fail("usage: write-launcher <bin> <temp-name> <target-name> <mode>");
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
  lock_directory(BIN_FD);
  require_component(argv[3]);
  require_component(argv[4]);
  if (!has_prefix(argv[3], ".hush-launcher-")) fail("invalid launcher temporary name: %s", argv[3]);
  char *end = NULL;
  long mode_value = strtol(argv[5], &end, 8);
  if (!end || *end || mode_value < 0 || mode_value > 0777) fail("invalid launcher mode: %s", argv[5]);

  int temporary = openat(
    BIN_FD,
    argv[3],
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    (mode_t)mode_value
  );
  if (temporary < 0) fail_errno("cannot create launcher temporary", argv[3]);
  copy_bytes(STDIN_FILENO, temporary, argv[3]);
  if (fchmod(temporary, (mode_t)mode_value) < 0 || fsync(temporary) < 0) {
    fail_errno("cannot finalize launcher temporary", argv[3]);
  }
  struct stat temporary_metadata;
  if (fstat(temporary, &temporary_metadata) < 0) {
    fail_errno("cannot inspect launcher temporary", argv[3]);
  }

  struct stat target_metadata;
  if (fstatat(BIN_FD, argv[4], &target_metadata, AT_SYMLINK_NOFOLLOW) == 0) {
    if (S_ISDIR(target_metadata.st_mode)) fail("Hush launcher target is a directory: %s", argv[4]);
  } else if (errno != ENOENT) {
    fail_errno("cannot inspect Hush launcher target", argv[4]);
  }

  if (renameat(BIN_FD, argv[3], BIN_FD, argv[4]) < 0) {
    int saved = errno;
    unlinkat(BIN_FD, argv[3], 0);
    close(temporary);
    errno = saved;
    fail_errno("cannot publish Hush launcher", argv[4]);
  }
  if (fsync(BIN_FD) < 0) fail_errno("cannot sync Hush launcher directory", argv[2]);
  int target = openat(BIN_FD, argv[4], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (target < 0) fail_errno("published Hush launcher is missing or symlinked:", argv[4]);
  struct stat metadata;
  if (fstat(target, &metadata) < 0) fail_errno("cannot inspect published Hush launcher", argv[4]);
  close(target);
  close(temporary);
  if (!same_inode(&temporary_metadata, &metadata)) {
    fail("published Hush launcher changed during publication: %s", argv[4]);
  }
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1 || !(metadata.st_mode & 0111)) {
    fail("published Hush launcher must be an executable single-link regular file: %s", argv[4]);
  }
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
}

static void command_read_launcher(int argc, char **argv) {
  if (argc != 4) fail("usage: read-launcher <bin> <target-name>");
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
  require_component(argv[3]);
  int target = openat(BIN_FD, argv[3], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (target < 0) fail_errno("Hush launcher is missing or symlinked:", argv[3]);
  struct stat metadata;
  if (fstat(target, &metadata) < 0) fail_errno("cannot inspect Hush launcher", argv[3]);
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
    fail("Hush launcher must be a single-link regular file: %s", argv[3]);
  }
  if (!(metadata.st_mode & 0111)) fail("Hush launcher is not executable: %s", argv[3]);
  copy_bytes(target, STDOUT_FILENO, argv[3]);
  close(target);
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
}

static int open_absolute_regular(const char *path) {
  if (!path || path[0] != '/') fail("file path must be absolute: %s", path ? path : "(null)");
  char *copy = strdup(path);
  if (!copy) fail_errno("cannot allocate path for", path);
  char *slash = strrchr(copy, '/');
  char *leaf = strdup(slash + 1);
  if (!leaf) fail_errno("cannot allocate leaf for", path);
  require_component(leaf);
  if (slash == copy) slash[1] = '\0';
  else *slash = '\0';
  int parent = open_absolute_directory(copy, false, 0);
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  close(parent);
  free(leaf);
  free(copy);
  if (fd < 0) fail_errno("resolved launcher is missing or symlinked:", path);
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) fail_errno("cannot inspect resolved launcher", path);
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
    fail("resolved launcher must be a single-link regular file: %s", path);
  }
  return fd;
}

static void command_same_launcher(int argc, char **argv) {
  if (argc != 5) fail("usage: same-launcher <bin> <target-name> <resolved-path>");
  require_bound_directory(argv[2], BIN_FD, "Hush bin root");
  require_component(argv[3]);
  int target = openat(BIN_FD, argv[3], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (target < 0) fail_errno("Hush launcher is missing or symlinked:", argv[3]);
  int resolved = open_absolute_regular(argv[4]);
  struct stat target_metadata;
  struct stat resolved_metadata;
  if (fstat(target, &target_metadata) < 0 || fstat(resolved, &resolved_metadata) < 0) {
    fail_errno("cannot compare Hush launcher", argv[4]);
  }
  close(target);
  close(resolved);
  if (!same_inode(&target_metadata, &resolved_metadata)) exit(3);
}

int main(int argc, char **argv) {
  if (argc < 2) fail("missing helper command");
  if (strcmp(argv[1], "guard") == 0) command_guard(argc, argv);
  else if (strcmp(argv[1], "check-roots") == 0) command_check_roots(argc, argv);
  else if (strcmp(argv[1], "stage") == 0) command_stage(argc, argv);
  else if (strcmp(argv[1], "entry-kind") == 0) command_entry_kind(argc, argv);
  else if (strcmp(argv[1], "run-at") == 0) command_run_at(argc, argv);
  else if (strcmp(argv[1], "publish-runtime") == 0) command_publish_runtime(argc, argv);
  else if (strcmp(argv[1], "list-runtimes") == 0) command_list_runtimes(argc, argv);
  else if (strcmp(argv[1], "remove-stale") == 0) command_remove_stale(argc, argv);
  else if (strcmp(argv[1], "prune-runtime") == 0) command_prune_runtime(argc, argv);
  else if (strcmp(argv[1], "cleanup-bin") == 0) command_cleanup_bin(argc, argv);
  else if (strcmp(argv[1], "write-launcher") == 0) command_write_launcher(argc, argv);
  else if (strcmp(argv[1], "read-launcher") == 0) command_read_launcher(argc, argv);
  else if (strcmp(argv[1], "same-launcher") == 0) command_same_launcher(argc, argv);
  else fail("unknown helper command: %s", argv[1]);
  return 0;
}
