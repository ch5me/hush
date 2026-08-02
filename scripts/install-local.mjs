#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNode24 } from "./install-local-helpers.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(dirname(scriptPath), ".."));
const manifestName = ".hush-runtime-manifest.json";
const stageMarkerName = ".hush-stage-owner";
const trackedSourcePaths = [
  ".npmrc",
  "bun.lock",
  "docs/package.json",
  "hush-cli/bin/hush.js",
  "hush-cli/package.json",
  "hush-cli/schema.json",
  "package.json",
];
const stagedSourcePaths = trackedSourcePaths.map((path) => `f:${path}`);
stagedSourcePaths.push("t:hush-cli/dist");

const guardedFds = {
  source: 10,
  runtimeParent: 11,
  bin: 12,
};
const pinnedBunEnv = "HUSH_INSTALL_PINNED_BUN_PATH";
const pinnedGitEnv = "HUSH_INSTALL_PINNED_GIT_PATH";
const loginNativeHelperEnv = "HUSH_INSTALL_LOGIN_NATIVE_HELPER";
const loginPathBlockStart = "# >>> hush managed login PATH >>>";
const loginPathBlockEnd = "# <<< hush managed login PATH <<<";
const loginNativeExtension = String.raw`
#if defined(__APPLE__)
#include <copyfile.h>
#include <sys/acl.h>
#include <sys/random.h>
#include <sys/xattr.h>
#elif defined(__linux__)
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/xattr.h>
#endif

#define LOGIN_EXPECTED_FD 3
#define LOGIN_METADATA_FD 4
#define LOGIN_PARENT_FD 5

static intmax_t login_mtime_ns(const struct stat *metadata) {
#if defined(__APPLE__)
  return (intmax_t)metadata->st_mtimespec.tv_sec * 1000000000
    + metadata->st_mtimespec.tv_nsec;
#else
  return (intmax_t)metadata->st_mtim.tv_sec * 1000000000
    + metadata->st_mtim.tv_nsec;
#endif
}

static intmax_t login_atime_ns(const struct stat *metadata) {
#if defined(__APPLE__)
  return (intmax_t)metadata->st_atimespec.tv_sec * 1000000000
    + metadata->st_atimespec.tv_nsec;
#else
  return (intmax_t)metadata->st_atim.tv_sec * 1000000000
    + metadata->st_atim.tv_nsec;
#endif
}

static intmax_t login_ctime_ns(const struct stat *metadata) {
#if defined(__APPLE__)
  return (intmax_t)metadata->st_ctimespec.tv_sec * 1000000000
    + metadata->st_ctimespec.tv_nsec;
#else
  return (intmax_t)metadata->st_ctim.tv_sec * 1000000000
    + metadata->st_ctim.tv_nsec;
#endif
}

static bool login_same_state(const struct stat *left, const struct stat *right) {
  return same_inode(left, right)
    && left->st_uid == right->st_uid
    && left->st_gid == right->st_gid
    && left->st_mode == right->st_mode
    && left->st_nlink == right->st_nlink
    && left->st_size == right->st_size
    && login_mtime_ns(left) == login_mtime_ns(right)
    && login_ctime_ns(left) == login_ctime_ns(right)
#if defined(__APPLE__)
    && left->st_flags == right->st_flags
#endif
    ;
}

static bool login_same_preserved_state(
  const struct stat *left,
  const struct stat *right
) {
  return same_inode(left, right)
    && left->st_uid == right->st_uid
    && left->st_gid == right->st_gid
    && left->st_mode == right->st_mode
    && left->st_nlink == right->st_nlink
    && left->st_size == right->st_size
    && login_mtime_ns(left) == login_mtime_ns(right)
#if defined(__APPLE__)
    && left->st_flags == right->st_flags
#endif
    ;
}

static bool login_capture_rename_transition(
  int fd,
  const struct stat *before,
  struct stat *after
) {
  return fstat(fd, after) == 0 && login_same_preserved_state(before, after);
}

static void login_print_state(const char *label, const struct stat *metadata) {
  if (
    printf(
      "%s\t%ju\t%ju\t%ju\t%ju\t%ju\t%ju\t%ju\t%jd\t%jd\n",
      label,
      (uintmax_t)metadata->st_dev,
      (uintmax_t)metadata->st_ino,
      (uintmax_t)metadata->st_uid,
      (uintmax_t)metadata->st_gid,
      (uintmax_t)metadata->st_mode,
      (uintmax_t)metadata->st_nlink,
      (uintmax_t)metadata->st_size,
      login_mtime_ns(metadata),
      login_ctime_ns(metadata)
    ) < 0
    || fflush(stdout) != 0
  ) {
    fail_errno("cannot emit startup publication receipt for", "startup file");
  }
}

static intmax_t login_parse_signed_part(const char *value, const char *label) {
  if (!value || !value[0]) fail("invalid %s: %s", label, value ? value : "(null)");
  errno = 0;
  char *end = NULL;
  intmax_t parsed = strtoimax(value, &end, 10);
  if (errno || !end || *end) fail("invalid %s: %s", label, value);
  return parsed;
}

static bool login_state_matches_args(const struct stat *metadata, char **values) {
  return (uintmax_t)metadata->st_dev
      == parse_identity_part(values[0], "startup device", 10)
    && (uintmax_t)metadata->st_ino
      == parse_identity_part(values[1], "startup inode", 10)
    && (uintmax_t)metadata->st_uid
      == parse_identity_part(values[2], "startup uid", 10)
    && (uintmax_t)metadata->st_gid
      == parse_identity_part(values[3], "startup gid", 10)
    && (uintmax_t)metadata->st_mode
      == parse_identity_part(values[4], "startup mode", 10)
    && (uintmax_t)metadata->st_nlink
      == parse_identity_part(values[5], "startup link count", 10)
    && (uintmax_t)metadata->st_size
      == parse_identity_part(values[6], "startup size", 10)
    && login_mtime_ns(metadata)
      == login_parse_signed_part(values[7], "startup modification time")
    && login_ctime_ns(metadata)
      == login_parse_signed_part(values[8], "startup change time");
}

static void login_require_regular(
  int fd,
  const struct stat *metadata,
  const char *path,
  bool linked
) {
  (void)fd;
  if (
    !S_ISREG(metadata->st_mode)
    || metadata->st_uid != geteuid()
    || (linked ? metadata->st_nlink != 1 : metadata->st_nlink > 1)
  ) {
    fail("startup file must be a user-owned single-link regular file: %s", path);
  }
  if ((metadata->st_mode & (S_ISUID | S_ISGID | S_ISVTX)) != 0) {
    fail("startup file has unsupported special mode bits: %s", path);
  }
}

#if defined(__linux__)
static void login_require_linux_metadata(int fd, const char *path) {
  ssize_t attributes = flistxattr(fd, NULL, 0);
  if (attributes < 0) {
    fail_errno("cannot inspect startup extended attributes for", path);
  }
  if (attributes > 0) {
    fail("startup file has extended attributes; refusing replacement: %s", path);
  }
  int flags = 0;
  if (ioctl(fd, FS_IOC_GETFLAGS, &flags) < 0) {
    if (errno != ENOTTY && errno != EOPNOTSUPP) {
      fail_errno("cannot inspect startup file flags for", path);
    }
    return;
  }
  int allowed = 0;
#ifdef FS_EXTENT_FL
  allowed |= FS_EXTENT_FL;
#endif
#ifdef FS_INDEX_FL
  allowed |= FS_INDEX_FL;
#endif
  if ((flags & ~allowed) != 0) {
    fail("startup file has unsupported file flags: %s", path);
  }
}
#endif

#if defined(__APPLE__)
struct login_blob {
  unsigned char *bytes;
  size_t length;
  bool present;
};

struct login_xattr {
  char *name;
  unsigned char *value;
  size_t length;
};

struct login_apple_metadata {
  struct login_blob acl;
  struct login_xattr *xattrs;
  size_t xattr_count;
};

static int login_compare_xattr_names(const void *left, const void *right) {
  const struct login_xattr *left_attribute = left;
  const struct login_xattr *right_attribute = right;
  return strcmp(left_attribute->name, right_attribute->name);
}

static struct login_blob login_capture_acl(int fd, const char *path) {
  errno = 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    if (errno != ENOENT && errno != EOPNOTSUPP) {
      fail_errno("cannot inspect startup ACL for", path);
    }
    return (struct login_blob){0};
  }
  ssize_t length = acl_size(acl);
  if (length < 0) fail_errno("cannot size startup ACL for", path);
  unsigned char *bytes = malloc(length == 0 ? 1 : (size_t)length);
  if (!bytes) fail("cannot allocate startup ACL snapshot");
  if (acl_copy_ext_native(bytes, acl, length) != length) {
    fail_errno("cannot snapshot startup ACL for", path);
  }
  acl_free(acl);
  return (struct login_blob){
    .bytes = bytes,
    .length = (size_t)length,
    .present = true,
  };
}

static struct login_apple_metadata login_capture_apple_metadata(
  int fd,
  const char *path
) {
  struct login_apple_metadata result = {
    .acl = login_capture_acl(fd, path),
  };
  ssize_t names_length = flistxattr(fd, NULL, 0, 0);
  if (names_length < 0) {
    fail_errno("cannot inspect startup extended attributes for", path);
  }
  if (names_length == 0) return result;
  char *names = malloc((size_t)names_length);
  if (!names) fail("cannot allocate startup extended attribute names");
  ssize_t captured_length = flistxattr(fd, names, (size_t)names_length, 0);
  if (captured_length != names_length) {
    fail("startup extended attributes changed during snapshot: %s", path);
  }
  for (size_t offset = 0; offset < (size_t)names_length;) {
    size_t remaining = (size_t)names_length - offset;
    size_t length = strnlen(names + offset, remaining);
    if (length == 0 || length == remaining) {
      fail("startup extended attribute listing is invalid: %s", path);
    }
    result.xattr_count++;
    offset += length + 1;
  }
  if (result.xattr_count > SIZE_MAX / sizeof(*result.xattrs)) {
    fail("startup extended attribute listing is too large: %s", path);
  }
  result.xattrs = calloc(result.xattr_count, sizeof(*result.xattrs));
  if (!result.xattrs) fail("cannot allocate startup extended attribute snapshot");
  size_t index = 0;
  for (size_t offset = 0; offset < (size_t)names_length; index++) {
    size_t length = strlen(names + offset);
    result.xattrs[index].name = strdup(names + offset);
    if (!result.xattrs[index].name) {
      fail("cannot allocate startup extended attribute name");
    }
    offset += length + 1;
  }
  free(names);
  qsort(
    result.xattrs,
    result.xattr_count,
    sizeof(*result.xattrs),
    login_compare_xattr_names
  );
  for (index = 0; index < result.xattr_count; index++) {
    struct login_xattr *attribute = &result.xattrs[index];
    ssize_t length = fgetxattr(fd, attribute->name, NULL, 0, 0, 0);
    if (length < 0) {
      fail("startup extended attributes changed during snapshot: %s", path);
    }
    attribute->length = (size_t)length;
    if (length == 0) continue;
    attribute->value = malloc((size_t)length);
    if (!attribute->value) {
      fail("cannot allocate startup extended attribute value");
    }
    if (
      fgetxattr(
        fd,
        attribute->name,
        attribute->value,
        attribute->length,
        0,
        0
      ) != length
    ) {
      fail("startup extended attributes changed during snapshot: %s", path);
    }
  }
  return result;
}

static bool login_same_blob(
  const struct login_blob *left,
  const struct login_blob *right
) {
  return left->present == right->present
    && left->length == right->length
    && (
      left->length == 0
      || memcmp(left->bytes, right->bytes, left->length) == 0
    );
}

static bool login_same_apple_metadata(
  const struct login_apple_metadata *left,
  const struct login_apple_metadata *right
) {
  if (
    !login_same_blob(&left->acl, &right->acl)
    || left->xattr_count != right->xattr_count
  ) {
    return false;
  }
  for (size_t index = 0; index < left->xattr_count; index++) {
    const struct login_xattr *left_attribute = &left->xattrs[index];
    const struct login_xattr *right_attribute = &right->xattrs[index];
    if (
      strcmp(left_attribute->name, right_attribute->name) != 0
      || left_attribute->length != right_attribute->length
      || (
        left_attribute->length > 0
        && memcmp(
          left_attribute->value,
          right_attribute->value,
          left_attribute->length
        ) != 0
      )
    ) {
      return false;
    }
  }
  return true;
}

static void login_free_apple_metadata(struct login_apple_metadata *metadata) {
  free(metadata->acl.bytes);
  for (size_t index = 0; index < metadata->xattr_count; index++) {
    free(metadata->xattrs[index].name);
    free(metadata->xattrs[index].value);
  }
  free(metadata->xattrs);
}
#endif

static void login_copy_metadata(
  int source,
  int destination,
  const struct stat *source_metadata,
  const char *path
) {
#if defined(__APPLE__)
  unsigned int dangerous = UF_IMMUTABLE | UF_APPEND | SF_IMMUTABLE | SF_APPEND;
  if ((source_metadata->st_flags & dangerous) != 0) {
    fail("startup file has immutable or append-only flags: %s", path);
  }
  struct login_apple_metadata before = login_capture_apple_metadata(source, path);
  pause_for_test("during-login-metadata-copy", path);
  copyfile_state_t state = copyfile_state_alloc();
  if (!state) fail("cannot allocate startup metadata copy state");
  if (fcopyfile(source, destination, state, COPYFILE_METADATA) < 0) {
    copyfile_state_free(state);
    fail_errno("cannot preserve startup metadata for", path);
  }
  copyfile_state_free(state);
  struct login_apple_metadata after = login_capture_apple_metadata(source, path);
  struct login_apple_metadata copied = login_capture_apple_metadata(destination, path);
  if (!login_same_apple_metadata(&before, &after)) {
    fail("startup ACL or extended attributes changed during copy: %s", path);
  }
  if (!login_same_apple_metadata(&before, &copied)) {
    fail("startup ACL or extended attributes were not preserved: %s", path);
  }
  login_free_apple_metadata(&before);
  login_free_apple_metadata(&after);
  login_free_apple_metadata(&copied);
#else
  login_require_linux_metadata(source, path);
  const struct timespec timestamps[2] = {
    source_metadata->st_atim,
    source_metadata->st_mtim,
  };
  if (futimens(destination, timestamps) < 0) {
    fail_errno("cannot preserve startup timestamps for", path);
  }
  struct stat copied;
  if (
    fstat(destination, &copied) < 0
    || login_atime_ns(&copied) != login_atime_ns(source_metadata)
    || login_mtime_ns(&copied) != login_mtime_ns(source_metadata)
  ) {
    fail("startup timestamps were not preserved: %s", path);
  }
#endif
}

static void login_require_new_metadata(
  int fd,
  const struct stat *metadata,
  const char *path
) {
#if defined(__APPLE__)
  if (metadata->st_flags != 0) {
    fail("new startup file inherited unsupported file flags: %s", path);
  }
  struct login_apple_metadata inherited = login_capture_apple_metadata(fd, path);
  bool inherited_acl = inherited.acl.present;
  bool inherited_xattrs = false;
  for (size_t index = 0; index < inherited.xattr_count; index++) {
    if (strcmp(inherited.xattrs[index].name, "com.apple.provenance") != 0) {
      inherited_xattrs = true;
      break;
    }
  }
  login_free_apple_metadata(&inherited);
  if (inherited_acl) {
    fail("new startup file inherited an ACL; refusing publication: %s", path);
  }
  if (inherited_xattrs) {
    fail("new startup file inherited extended attributes; refusing publication: %s", path);
  }
#else
  login_require_linux_metadata(fd, path);
  (void)metadata;
#endif
}

static bool login_bytes_equal(int fd, const unsigned char *expected, size_t length) {
  if (lseek(fd, 0, SEEK_SET) < 0) fail_errno("cannot seek", "startup file");
  unsigned char buffer[64 * 1024];
  size_t offset = 0;
  while (offset < length) {
    size_t wanted = length - offset < sizeof(buffer) ? length - offset : sizeof(buffer);
    ssize_t count = read(fd, buffer, wanted);
    if (count < 0) fail_errno("cannot read", "startup file");
    if (count == 0 || memcmp(buffer, expected + offset, (size_t)count) != 0) {
      return false;
    }
    offset += (size_t)count;
  }
  unsigned char extra;
  ssize_t trailing = read(fd, &extra, 1);
  if (trailing < 0) fail_errno("cannot read", "startup file");
  return trailing == 0;
}

static unsigned char *login_read_input(size_t length) {
  unsigned char *buffer = malloc(length == 0 ? 1 : length);
  if (!buffer) fail("cannot allocate startup input");
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(STDIN_FILENO, buffer + offset, length - offset);
    if (count < 0) fail_errno("cannot read", "startup input");
    if (count == 0) fail("startup input ended early");
    offset += (size_t)count;
  }
  unsigned char extra;
  ssize_t trailing = read(STDIN_FILENO, &extra, 1);
  if (trailing < 0) fail_errno("cannot read", "startup input");
  if (trailing != 0) fail("startup input has trailing bytes");
  return buffer;
}

static bool login_fd_matches_state(int fd, const struct stat *expected) {
  struct stat current;
  return fstat(fd, &current) == 0 && login_same_state(expected, &current);
}

static bool login_name_matches_state(
  int parent,
  const char *name,
  int fd,
  const struct stat *expected,
  const unsigned char *bytes,
  size_t length,
  bool compare_bytes
) {
  struct stat path_metadata;
  struct stat opened_metadata;
  struct stat final_expected;
  struct stat final_path;
  login_require_regular(fd, expected, name, true);
  if (!login_fd_matches_state(fd, expected)) return false;
  if (fstatat(parent, name, &path_metadata, AT_SYMLINK_NOFOLLOW) < 0) return false;
  if (!login_same_state(expected, &path_metadata)) return false;
  int opened = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (opened < 0) return false;
  bool matches = fstat(opened, &opened_metadata) == 0
    && login_same_state(expected, &opened_metadata)
    && (!compare_bytes || login_bytes_equal(opened, bytes, length))
    && fstat(fd, &final_expected) == 0
    && login_same_state(expected, &final_expected)
    && fstatat(parent, name, &final_path, AT_SYMLINK_NOFOLLOW) == 0
    && login_same_state(expected, &final_path);
  close(opened);
  return matches;
}

static bool login_name_matches_inode(int parent, const char *name, int fd) {
  struct stat expected;
  struct stat path_metadata;
  struct stat opened_metadata;
  struct stat final_expected;
  struct stat final_path;
  if (fstat(fd, &expected) < 0) return false;
  if (
    fstatat(parent, name, &path_metadata, AT_SYMLINK_NOFOLLOW) < 0
    || !same_inode(&expected, &path_metadata)
  ) {
    return false;
  }
  int opened = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (opened < 0) return false;
  bool matches = fstat(opened, &opened_metadata) == 0
    && same_inode(&expected, &opened_metadata)
    && fstat(fd, &final_expected) == 0
    && same_inode(&expected, &final_expected)
    && fstatat(parent, name, &final_path, AT_SYMLINK_NOFOLLOW) == 0
    && same_inode(&expected, &final_path);
  close(opened);
  return matches;
}

static void login_write_all(
  int fd,
  const unsigned char *bytes,
  size_t length,
  const char *name
) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) fail_errno("cannot write startup temporary", name);
    if (count == 0) fail("cannot write startup temporary: %s", name);
    offset += (size_t)count;
  }
}

static bool login_random_name(char *buffer, size_t size, const char *prefix) {
  unsigned char random[16];
  if (getentropy(random, sizeof(random)) < 0) return false;
  int written = snprintf(
    buffer,
    size,
    "%s%ld-"
    "%02x%02x%02x%02x%02x%02x%02x%02x"
    "%02x%02x%02x%02x%02x%02x%02x%02x",
    prefix,
    (long)getpid(),
    random[0], random[1], random[2], random[3],
    random[4], random[5], random[6], random[7],
    random[8], random[9], random[10], random[11],
    random[12], random[13], random[14], random[15]
  );
  return written >= 0 && (size_t)written < size;
}

static bool login_claim_and_unlink(
  int parent,
  const char *name,
  int fd,
  const struct stat *state,
  const unsigned char *bytes,
  size_t length,
  bool compare_bytes
) {
  char claim[96];
  if (!login_random_name(claim, sizeof(claim), ".hush-login-claim-")) {
    fprintf(stderr, "hush install helper warning: cannot name startup cleanup claim: %s\n", name);
    return false;
  }
  if (rename_noreplace(parent, name, parent, claim) < 0) {
    fprintf(stderr, "hush install helper warning: cannot claim startup cleanup: %s\n", name);
    return false;
  }
  struct stat claimed_state;
  bool claimed = login_capture_rename_transition(fd, state, &claimed_state)
    && login_name_matches_state(
      parent,
      claim,
      fd,
      &claimed_state,
      bytes,
      length,
      compare_bytes
    );
  if (!claimed) {
    if (rename_noreplace(parent, claim, parent, name) < 0) {
      fprintf(
        stderr,
        "hush install helper warning: startup cleanup replacement preserved at %s\n",
        claim
      );
    }
    return false;
  }

  pause_for_test("before-login-cleanup-seal", claim);
  struct stat claim_before;
  if (
    fstatat(parent, claim, &claim_before, AT_SYMLINK_NOFOLLOW) < 0
    || !same_inode(&claimed_state, &claim_before)
  ) {
    fprintf(
      stderr,
      "hush install helper warning: startup cleanup claim changed; preserved at %s\n",
      claim
    );
    return false;
  }
  fprintf(
    stderr,
    "hush install helper warning: descriptor-bound startup cleanup preserved at %s\n",
    claim
  );
  return false;
}

static int login_pending_parent = -1;
static int login_pending_fd = -1;
static const char *login_pending_name = NULL;

static void login_cleanup_pending(void) {
  struct stat expected;
  if (
    login_pending_parent < 0
    || login_pending_fd < 0
    || !login_pending_name
    || fstat(login_pending_fd, &expected) < 0
  ) {
    return;
  }
  login_claim_and_unlink(
    login_pending_parent,
    login_pending_name,
    login_pending_fd,
    &expected,
    NULL,
    0,
    false
  );
}

static void login_arm_cleanup(int parent, const char *name, int fd) {
  static bool registered = false;
  login_pending_parent = parent;
  login_pending_name = name;
  login_pending_fd = fd;
  if (!registered) {
    if (atexit(login_cleanup_pending) != 0) {
      login_cleanup_pending();
      close(fd);
      login_pending_parent = -1;
      login_pending_name = NULL;
      login_pending_fd = -1;
      fail("cannot register startup temporary cleanup");
    }
    registered = true;
  }
}

static void login_disarm_cleanup(void) {
  login_pending_parent = -1;
  login_pending_name = NULL;
  login_pending_fd = -1;
}

static int login_create_temporary(
  int parent,
  const char *name,
  const unsigned char *bytes,
  size_t length,
  int metadata_source,
  mode_t default_mode,
  struct stat *created_state
) {
  int fd = openat(
    parent,
    name,
    O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (fd < 0) fail_errno("cannot create startup temporary", name);
  login_arm_cleanup(parent, name, fd);
  login_write_all(fd, bytes, length, name);

  struct stat parent_metadata;
  struct stat source_metadata;
  uid_t uid = geteuid();
  gid_t gid;
  mode_t mode;
  if (metadata_source >= 0) {
    if (fstat(metadata_source, &source_metadata) < 0) {
      fail_errno("cannot inspect startup metadata source", name);
    }
    login_require_regular(metadata_source, &source_metadata, name, false);
    uid = source_metadata.st_uid;
    gid = source_metadata.st_gid;
    mode = source_metadata.st_mode & 0777;
  } else {
    if (fstat(parent, &parent_metadata) < 0) {
      fail_errno("cannot inspect startup directory", name);
    }
    gid = parent_metadata.st_gid;
    mode = default_mode;
  }

  struct stat current;
  if (fstat(fd, &current) < 0) fail_errno("cannot inspect startup temporary", name);
  if ((current.st_uid != uid || current.st_gid != gid) && fchown(fd, uid, gid) < 0) {
    fail_errno("cannot preserve startup ownership for", name);
  }
  if (fchmod(fd, mode) < 0) fail_errno("cannot preserve startup mode for", name);
  if (metadata_source >= 0) {
    login_copy_metadata(metadata_source, fd, &source_metadata, name);
    if (!login_fd_matches_state(metadata_source, &source_metadata)) {
      fail("startup metadata source changed during copy: %s", name);
    }
  } else {
    if (fstat(fd, &current) < 0) {
      fail_errno("cannot inspect new startup temporary", name);
    }
    login_require_new_metadata(fd, &current, name);
  }
  if (fsync(fd) < 0) fail_errno("cannot finalize startup temporary", name);
  if (fstat(fd, created_state) < 0) {
    fail_errno("cannot inspect finalized startup temporary", name);
  }
  login_require_regular(fd, created_state, name, true);
  if (
    created_state->st_uid != uid
    || created_state->st_gid != gid
    || (created_state->st_mode & 07777) != mode
    || (
      metadata_source >= 0
      && (
        login_atime_ns(created_state) != login_atime_ns(&source_metadata)
        || login_mtime_ns(created_state) != login_mtime_ns(&source_metadata)
      )
    )
#if defined(__APPLE__)
    || (metadata_source >= 0 && created_state->st_flags != source_metadata.st_flags)
#endif
  ) {
    fail("startup temporary metadata differs from intended state: %s", name);
  }
  return fd;
}

static bool login_bind_name(
  int parent,
  const char *name,
  int fd,
  const struct stat *state,
  const unsigned char *bytes,
  size_t length,
  char *bound,
  size_t bound_size,
  struct stat *bound_state
) {
  if (!login_random_name(bound, bound_size, ".hush-login-bound-")) return false;
  if (rename_noreplace(parent, name, parent, bound) < 0) return false;
  bool matches = login_capture_rename_transition(fd, state, bound_state)
    && login_name_matches_state(
      parent,
      bound,
      fd,
      bound_state,
      bytes,
      length,
      true
    );
  if (!matches) rename_noreplace(parent, bound, parent, name);
  return matches;
}
static int login_rename_exchange(
  int left_fd,
  const char *left,
  int right_fd,
  const char *right
) {
#if defined(__APPLE__)
  return renameatx_np(left_fd, left, right_fd, right, RENAME_SWAP);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(
    SYS_renameat2,
    left_fd,
    left,
    right_fd,
    right,
    RENAME_EXCHANGE
  );
#else
  errno = ENOTSUP;
  return -1;
#endif
}

static bool login_cleanup_exact(
  int parent,
  const char *name,
  int fd,
  const struct stat *state,
  const unsigned char *bytes,
  size_t length
) {
  return login_claim_and_unlink(
    parent,
    name,
    fd,
    state,
    bytes,
    length,
    true
  );
}

static bool login_parent_matches_path(int parent, const char *directory) {
  int current = open(
    directory,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (current < 0) return false;
  struct stat expected;
  struct stat actual;
  bool matches = fstat(parent, &expected) == 0
    && fstat(current, &actual) == 0
    && same_inode(&expected, &actual);
  close(current);
  return matches;
}

static int login_open_parent(const char *directory) {
  int parent = openat(
    LOGIN_PARENT_FD,
    ".",
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (parent < 0) {
    fail_errno("cannot duplicate startup directory descriptor", directory);
  }
  struct stat metadata;
  if (fstat(parent, &metadata) < 0) {
    fail_errno("cannot inspect startup directory", directory);
  }
  if (
    !S_ISDIR(metadata.st_mode)
    || metadata.st_uid != geteuid()
    || (metadata.st_mode & 0022) != 0
  ) {
    fail(
      "startup directory must be user-owned and not group/world writable: %s",
      directory
    );
  }
  if (!login_parent_matches_path(parent, directory)) {
    fail("startup directory changed before publication: %s", directory);
  }
  lock_directory(parent);
  if (!login_parent_matches_path(parent, directory)) {
    fail("startup directory changed while acquiring publication lock: %s", directory);
  }
  return parent;
}

static _Noreturn void login_fail_after_existing_exchange_restore(
  int parent,
  const char *target,
  const char *temporary,
  int installed_fd,
  const struct stat *installed_state,
  const unsigned char *installed_bytes,
  size_t installed_length,
  int original_fd,
  const struct stat *original_state,
  const unsigned char *original_bytes,
  size_t original_length,
  const char *reason
) {
  if (login_rename_exchange(parent, target, parent, temporary) < 0) {
    fail_errno("cannot restore startup file after failed publication", target);
  }
  struct stat restored_state;
  struct stat replacement_state;
  bool original_transition = login_capture_rename_transition(
    original_fd,
    original_state,
    &restored_state
  );
  bool replacement_transition = login_capture_rename_transition(
    installed_fd,
    installed_state,
    &replacement_state
  );
  if (
    !original_transition
    || !login_name_matches_state(
      parent,
      target,
      original_fd,
      &restored_state,
      original_bytes,
      original_length,
      true
    )
    || !login_name_matches_inode(parent, temporary, installed_fd)
  ) {
    fail("startup publication recovery changed concurrently: %s", target);
  }
  bool changed_replacement = !replacement_transition
    || !login_name_matches_state(
      parent,
      temporary,
      installed_fd,
      &replacement_state,
      installed_bytes,
      installed_length,
      true
    );
  bool replacement_preserved = changed_replacement || !login_claim_and_unlink(
    parent,
    temporary,
    installed_fd,
    &replacement_state,
    installed_bytes,
    installed_length,
    true
  );
  if (fsync(parent) < 0) {
    fail_errno("cannot sync restored startup directory", target);
  }
  if (replacement_preserved) {
    fail(
      "%s; original restored and changed replacement preserved: %s",
      reason,
      target
    );
  }
  fail("%s; original restored: %s", reason, target);
}

static _Noreturn void login_fail_after_existing_copy_restore(
  int parent,
  const char *target,
  const char *recovery,
  int installed_fd,
  const struct stat *installed_state,
  const unsigned char *installed_bytes,
  size_t installed_length,
  int original_fd,
  const unsigned char *original_bytes,
  size_t original_length,
  const char *reason
) {
  if (!login_name_matches_inode(parent, target, installed_fd)) {
    fail("%s; startup target changed and was preserved: %s", reason, target);
  }
  struct stat recovery_state;
  int recovery_fd = login_create_temporary(
    parent,
    recovery,
    original_bytes,
    original_length,
    original_fd,
    0600,
    &recovery_state
  );
  if (
    !login_name_matches_inode(parent, target, installed_fd)
    || !login_name_matches_state(
      parent,
      recovery,
      recovery_fd,
      &recovery_state,
      original_bytes,
      original_length,
      true
    )
  ) {
    login_cleanup_exact(
      parent,
      recovery,
      recovery_fd,
      &recovery_state,
      original_bytes,
      original_length
    );
    login_disarm_cleanup();
    fail("%s; startup changed before recovery: %s", reason, target);
  }
  if (login_rename_exchange(parent, recovery, parent, target) < 0) {
    int saved_errno = errno;
    login_cleanup_exact(
      parent,
      recovery,
      recovery_fd,
      &recovery_state,
      original_bytes,
      original_length
    );
    login_disarm_cleanup();
    errno = saved_errno;
    fail_errno("cannot restore startup file after failed publication", target);
  }
  login_disarm_cleanup();
  struct stat restored_state;
  struct stat replacement_state;
  bool original_transition = login_capture_rename_transition(
    recovery_fd,
    &recovery_state,
    &restored_state
  );
  bool replacement_transition = login_capture_rename_transition(
    installed_fd,
    installed_state,
    &replacement_state
  );
  if (
    !original_transition
    || !login_name_matches_state(
      parent,
      target,
      recovery_fd,
      &restored_state,
      original_bytes,
      original_length,
      true
    )
    || !login_name_matches_inode(parent, recovery, installed_fd)
  ) {
    fail("startup publication recovery changed concurrently: %s", target);
  }
  bool changed_replacement = !replacement_transition
    || !login_name_matches_state(
      parent,
      recovery,
      installed_fd,
      &replacement_state,
      installed_bytes,
      installed_length,
      true
    );
  bool replacement_preserved = changed_replacement || !login_claim_and_unlink(
    parent,
    recovery,
    installed_fd,
    &replacement_state,
    installed_bytes,
    installed_length,
    true
  );
  if (fsync(parent) < 0) {
    fail_errno("cannot sync restored startup directory", target);
  }
  close(recovery_fd);
  if (replacement_preserved) {
    fail(
      "%s; original restored and changed replacement preserved: %s",
      reason,
      target
    );
  }
  fail("%s; original restored: %s", reason, target);
}

static _Noreturn void login_fail_after_absent_restore(
  int parent,
  const char *target,
  const char *recovery,
  int installed_fd,
  const struct stat *installed_state,
  const unsigned char *installed_bytes,
  size_t installed_length,
  const char *reason
) {
  if (!login_name_matches_inode(parent, target, installed_fd)) {
    fail("%s; startup target changed and was preserved: %s", reason, target);
  }
  if (rename_noreplace(parent, target, parent, recovery) < 0) {
    fail_errno("cannot quarantine failed startup publication", target);
  }
  struct stat quarantined_state;
  bool publication_transition = login_capture_rename_transition(
    installed_fd,
    installed_state,
    &quarantined_state
  );
  if (!login_name_matches_inode(parent, recovery, installed_fd)) {
    fail("failed startup publication changed during quarantine: %s", target);
  }
  bool changed_replacement = !publication_transition
    || !login_name_matches_state(
      parent,
      recovery,
      installed_fd,
      &quarantined_state,
      installed_bytes,
      installed_length,
      true
    );
  bool replacement_preserved = changed_replacement || !login_claim_and_unlink(
    parent,
    recovery,
    installed_fd,
    &quarantined_state,
    installed_bytes,
    installed_length,
    true
  );
  if (fsync(parent) < 0) {
    fail_errno("cannot sync restored startup directory", target);
  }
  if (replacement_preserved) {
    fail(
      "%s; original absence restored and changed replacement preserved: %s",
      reason,
      target
    );
  }
  fail("%s; original absence restored: %s", reason, target);
}

static void command_login_write(int argc, char **argv) {
  if (argc != 10) {
    fail(
      "usage: login-write <dir> <target> <temp> <recovery> <exists> "
      "<old-length> <new-length> <mode>"
    );
  }
  const char *directory = argv[2];
  const char *target = argv[3];
  const char *temporary = argv[4];
  const char *recovery = argv[5];
  require_component(target);
  require_component(temporary);
  require_component(recovery);
  if (
    strcmp(temporary, recovery) == 0
    || !has_prefix(temporary, ".hush-login-")
    || !has_prefix(recovery, ".hush-login-")
  ) {
    fail("invalid startup temporary name");
  }
  bool exists;
  if (strcmp(argv[6], "1") == 0) exists = true;
  else if (strcmp(argv[6], "0") == 0) exists = false;
  else fail("invalid startup expected state");
  size_t old_length = (size_t)parse_identity_part(
    argv[7],
    "startup old length",
    10
  );
  size_t new_length = (size_t)parse_identity_part(
    argv[8],
    "startup new length",
    10
  );
  mode_t default_mode = (mode_t)parse_identity_part(
    argv[9],
    "startup mode",
    8
  );
  unsigned char *input = login_read_input(old_length + new_length);
  const unsigned char *desired = input + old_length;
  int parent = login_open_parent(directory);
  struct stat expected_state;
  struct stat temporary_state;
  struct stat published_state;
  struct stat bound_state;
  char bound[96];

  if (exists) {
    if (fstat(LOGIN_EXPECTED_FD, &expected_state) < 0) {
      fail_errno("cannot inspect startup source descriptor", target);
    }
    login_require_regular(LOGIN_EXPECTED_FD, &expected_state, target, true);
    if (!login_name_matches_state(
      parent,
      target,
      LOGIN_EXPECTED_FD,
      &expected_state,
      input,
      old_length,
      true
    )) {
      fail("startup file changed before publish: %s", target);
    }
  } else {
    struct stat unexpected;
    if (
      fstatat(parent, target, &unexpected, AT_SYMLINK_NOFOLLOW) == 0
      || errno != ENOENT
    ) {
      fail("startup file appeared before publish: %s", target);
    }
  }

  int temporary_fd = login_create_temporary(
    parent,
    temporary,
    desired,
    new_length,
    exists ? LOGIN_METADATA_FD : -1,
    default_mode,
    &temporary_state
  );
  pause_for_test("after-login-temp-create", temporary);

  struct stat unexpected;
  bool expected_still_matches = exists
    ? login_name_matches_state(
      parent,
      target,
      LOGIN_EXPECTED_FD,
      &expected_state,
      input,
      old_length,
      true
    )
    : fstatat(parent, target, &unexpected, AT_SYMLINK_NOFOLLOW) < 0
      && errno == ENOENT;
  if (!expected_still_matches) {
    login_cleanup_exact(
      parent,
      temporary,
      temporary_fd,
      &temporary_state,
      desired,
      new_length
    );
    login_disarm_cleanup();
    fail("startup file changed during publish: %s", target);
  }
  if (!login_parent_matches_path(parent, directory)) {
    login_cleanup_exact(
      parent,
      temporary,
      temporary_fd,
      &temporary_state,
      desired,
      new_length
    );
    login_disarm_cleanup();
    fail("startup directory changed during publish: %s", directory);
  }
  pause_for_test("before-login-publish-bind", temporary);
  if (!login_bind_name(
    parent,
    temporary,
    temporary_fd,
    &temporary_state,
    desired,
    new_length,
    bound,
    sizeof(bound),
    &bound_state
  )) {
    login_disarm_cleanup();
    fail(
      "startup temporary changed while binding for publish; preserved replacement: %s",
      temporary
    );
  }
  login_pending_name = bound;

  if (exists) {
    if (login_rename_exchange(parent, bound, parent, target) < 0) {
      int saved_errno = errno;
      login_cleanup_exact(
        parent,
        bound,
        temporary_fd,
        &bound_state,
        desired,
        new_length
      );
      login_disarm_cleanup();
      errno = saved_errno;
      fail_errno("cannot atomically exchange startup file", target);
    }
    login_disarm_cleanup();
    struct stat displaced_state;
    bool publication_transition = login_capture_rename_transition(
      temporary_fd,
      &bound_state,
      &published_state
    );
    bool displaced_transition = login_capture_rename_transition(
      LOGIN_EXPECTED_FD,
      &expected_state,
      &displaced_state
    );
    pause_for_test("after-login-publish-exchange", temporary);
    bool target_ok = publication_transition
      && login_name_matches_state(
        parent,
        target,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        true
      );
    bool displaced_ok = displaced_transition
      && login_name_matches_state(
        parent,
        bound,
        LOGIN_EXPECTED_FD,
        &displaced_state,
        input,
        old_length,
        true
      );
    bool parent_ok = login_parent_matches_path(parent, directory);
    if (!target_ok || !displaced_ok || !parent_ok) {
      const char *reason = !parent_ok
        ? "startup directory changed during atomic publish"
        : !target_ok
          ? "startup file changed during atomic publish"
          : "displaced startup file changed during atomic publish";
      if (login_name_matches_inode(parent, target, temporary_fd)) {
        if (displaced_ok) {
          login_fail_after_existing_exchange_restore(
            parent,
            target,
            bound,
            temporary_fd,
            &published_state,
            desired,
            new_length,
            LOGIN_EXPECTED_FD,
            &displaced_state,
            input,
            old_length,
            reason
          );
        }
        login_fail_after_existing_copy_restore(
          parent,
          target,
          recovery,
          temporary_fd,
          &published_state,
          desired,
          new_length,
          LOGIN_METADATA_FD,
          input,
          old_length,
          reason
        );
      }
      fail("%s; startup target changed and was preserved: %s", reason, target);
    }
    pause_for_test("before-login-displaced-unlink", bound);
    target_ok = login_name_matches_state(
      parent,
      target,
      temporary_fd,
      &published_state,
      desired,
      new_length,
      true
    );
    displaced_ok = login_name_matches_state(
      parent,
      bound,
      LOGIN_EXPECTED_FD,
      &displaced_state,
      input,
      old_length,
      true
    );
    parent_ok = login_parent_matches_path(parent, directory);
    if (!target_ok || !displaced_ok || !parent_ok) {
      const char *reason = !parent_ok
        ? "startup directory changed before displaced cleanup"
        : !target_ok
          ? "published startup file changed before displaced cleanup"
          : "displaced startup file changed before cleanup";
      if (login_name_matches_inode(parent, target, temporary_fd)) {
        if (displaced_ok) {
          login_fail_after_existing_exchange_restore(
            parent,
            target,
            bound,
            temporary_fd,
            &published_state,
            desired,
            new_length,
            LOGIN_EXPECTED_FD,
            &displaced_state,
            input,
            old_length,
            reason
          );
        }
        login_fail_after_existing_copy_restore(
          parent,
          target,
          recovery,
          temporary_fd,
          &published_state,
          desired,
          new_length,
          LOGIN_METADATA_FD,
          input,
          old_length,
          reason
        );
      }
      fail("%s; startup target changed and was preserved: %s", reason, target);
    }
    if (fsync(parent) < 0) {
      login_fail_after_existing_exchange_restore(
        parent,
        target,
        bound,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        LOGIN_EXPECTED_FD,
        &displaced_state,
        input,
        old_length,
        "startup directory sync failed before displaced cleanup"
      );
    }
    if (!login_claim_and_unlink(
      parent,
      bound,
      LOGIN_EXPECTED_FD,
      &displaced_state,
      input,
      old_length,
      true
    )) {
      fprintf(
        stderr,
        "hush install helper warning: published startup is active, but displaced "
        "startup cleanup failed; preserved: %s\n",
        temporary
      );
    } else if (fsync(parent) < 0) {
      fprintf(
        stderr,
        "hush install helper warning: published startup is active, but displaced "
        "cleanup directory sync failed: %s\n",
        temporary
      );
    }
  } else {
    if (rename_noreplace(parent, bound, parent, target) < 0) {
      int saved_errno = errno;
      login_cleanup_exact(
        parent,
        bound,
        temporary_fd,
        &bound_state,
        desired,
        new_length
      );
      login_disarm_cleanup();
      errno = saved_errno;
      fail_errno("cannot publish new startup file", target);
    }
    login_disarm_cleanup();
    bool publication_transition = login_capture_rename_transition(
      temporary_fd,
      &bound_state,
      &published_state
    );
    pause_for_test("after-login-publish-noreplace", target);
    if (
      !publication_transition
      || !login_name_matches_state(
        parent,
        target,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        true
      )
      || !login_parent_matches_path(parent, directory)
    ) {
      login_fail_after_absent_restore(
        parent,
        target,
        recovery,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        "new startup publication changed before validation"
      );
    }
    if (fsync(parent) < 0) {
      login_fail_after_absent_restore(
        parent,
        target,
        recovery,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        "startup directory sync failed after new publication"
      );
    }
    if (
      !login_name_matches_state(
        parent,
        target,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        true
      )
      || !login_parent_matches_path(parent, directory)
    ) {
      login_fail_after_absent_restore(
        parent,
        target,
        recovery,
        temporary_fd,
        &published_state,
        desired,
        new_length,
        "new startup publication changed after directory sync"
      );
    }
  }

  login_print_state("published", &published_state);
  if (exists) {
    struct stat preserved_source_state;
    if (fstat(LOGIN_EXPECTED_FD, &preserved_source_state) < 0) {
      fail_errno("cannot inspect preserved startup source", target);
    }
    login_print_state("original", &preserved_source_state);
  } else if (printf("original\t-\n") < 0 || fflush(stdout) != 0) {
    fail_errno("cannot emit startup publication receipt for", target);
  }
  login_disarm_cleanup();
  close(temporary_fd);
  close(parent);
  free(input);
}

static void command_login_preserve(int argc, char **argv) {
  if (argc != 15) {
    fail(
      "usage: login-preserve <dir> <recovery> <length> <mode> "
      "<device> <inode> <uid> <gid> <file-mode> <links> <size> <mtime> <ctime>"
    );
  }
  const char *directory = argv[2];
  const char *recovery = argv[3];
  require_component(recovery);
  if (!has_prefix(recovery, ".hush-login-recovery-")) {
    fail("invalid startup recovery name");
  }
  size_t length = (size_t)parse_identity_part(
    argv[4],
    "startup recovery length",
    10
  );
  mode_t default_mode = (mode_t)parse_identity_part(
    argv[5],
    "startup recovery mode",
    8
  );
  unsigned char *expected = login_read_input(length);
  int parent = login_open_parent(directory);
  struct stat source_state;
  struct stat metadata_state;
  if (
    fstat(LOGIN_EXPECTED_FD, &source_state) < 0
    || fstat(LOGIN_METADATA_FD, &metadata_state) < 0
  ) {
    fail_errno("cannot inspect startup recovery source", recovery);
  }
  login_require_regular(LOGIN_EXPECTED_FD, &source_state, recovery, false);
  if (
    !same_inode(&source_state, &metadata_state)
    || !login_state_matches_args(&source_state, &argv[6])
    || !login_bytes_equal(LOGIN_EXPECTED_FD, expected, length)
  ) {
    fail("startup recovery source changed before preservation: %s", recovery);
  }
  struct stat recovery_state;
  int recovery_fd = login_create_temporary(
    parent,
    recovery,
    expected,
    length,
    LOGIN_METADATA_FD,
    default_mode,
    &recovery_state
  );
  if (
    fstat(LOGIN_EXPECTED_FD, &source_state) < 0
    || !login_state_matches_args(&source_state, &argv[6])
    || !login_bytes_equal(LOGIN_EXPECTED_FD, expected, length)
    || !login_name_matches_state(
      parent,
      recovery,
      recovery_fd,
      &recovery_state,
      expected,
      length,
      true
    )
  ) {
    fail("startup recovery source changed during preservation: %s", recovery);
  }
  if (fsync(parent) < 0) {
    fail_errno("cannot sync startup recovery directory", recovery);
  }
  login_disarm_cleanup();
  close(recovery_fd);
  close(parent);
  free(expected);
}

static void command_login_remove(int argc, char **argv) {
  if (argc != 6) {
    fail("usage: login-remove <dir> <target> <quarantine> <expected-length>");
  }
  const char *directory = argv[2];
  const char *target = argv[3];
  const char *quarantine = argv[4];
  require_component(target);
  require_component(quarantine);
  if (!has_prefix(quarantine, ".hush-login-")) {
    fail("invalid startup quarantine name");
  }
  size_t length = (size_t)parse_identity_part(
    argv[5],
    "startup expected length",
    10
  );
  unsigned char *expected = login_read_input(length);
  int parent = login_open_parent(directory);
  struct stat expected_state;
  if (fstat(LOGIN_EXPECTED_FD, &expected_state) < 0) {
    fail_errno("cannot inspect rollback descriptor", target);
  }
  login_require_regular(LOGIN_EXPECTED_FD, &expected_state, target, true);
  if (!login_name_matches_state(
    parent,
    target,
    LOGIN_EXPECTED_FD,
    &expected_state,
    expected,
    length,
    true
  )) {
    fail("startup file changed before rollback: %s", target);
  }

  pause_for_test("before-login-rollback-remove", target);
  if (
    !login_name_matches_state(
      parent,
      target,
      LOGIN_EXPECTED_FD,
      &expected_state,
      expected,
      length,
      true
    )
    || !login_parent_matches_path(parent, directory)
  ) {
    fail("startup file changed before rollback: %s", target);
  }
  if (rename_noreplace(parent, target, parent, quarantine) < 0) {
    fail_errno("cannot quarantine startup file for rollback", target);
  }
  struct stat quarantine_state;
  bool quarantine_transition = login_capture_rename_transition(
    LOGIN_EXPECTED_FD,
    &expected_state,
    &quarantine_state
  );
  if (
    !quarantine_transition
    || !login_name_matches_state(
      parent,
      quarantine,
      LOGIN_EXPECTED_FD,
      &quarantine_state,
      expected,
      length,
      true
    )
  ) {
    fprintf(
      stderr,
      "hush install helper warning: rollback restored startup absence, but "
      "the quarantined publication changed and was preserved: %s\n",
      quarantine
    );
    fsync(parent);
    close(parent);
    free(expected);
    return;
  }
  pause_for_test("before-login-quarantine-unlink", quarantine);
  if (!login_name_matches_state(
    parent,
    quarantine,
    LOGIN_EXPECTED_FD,
    &quarantine_state,
    expected,
    length,
    true
  )) {
    fprintf(
      stderr,
      "hush install helper warning: rollback retained startup absence and "
      "preserved a changed quarantine: %s\n",
      quarantine
    );
    fsync(parent);
    close(parent);
    free(expected);
    return;
  }
  if (!login_claim_and_unlink(
    parent,
    quarantine,
    LOGIN_EXPECTED_FD,
    &quarantine_state,
    expected,
    length,
    true
  )) {
    fprintf(
      stderr,
      "hush install helper warning: rollback retained startup absence, but "
      "the quarantined publication could not be removed: %s\n",
      quarantine
    );
  } else if (fsync(parent) < 0) {
    fprintf(
      stderr,
      "hush install helper warning: rollback retained startup absence, but "
      "directory sync failed after quarantine cleanup: %s\n",
      quarantine
    );
  }
  close(parent);
  free(expected);
}

int main(int argc, char **argv) {
  if (argc < 2) fail("missing login helper command");
  if (strcmp(argv[1], "login-write") == 0) {
    command_login_write(argc, argv);
  } else if (strcmp(argv[1], "login-preserve") == 0) {
    command_login_preserve(argc, argv);
  } else if (strcmp(argv[1], "login-remove") == 0) {
    command_login_remove(argc, argv);
  } else {
    fail("unknown login helper command: %s", argv[1]);
  }
  return 0;
}
`;

export class HushInstallError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HushInstallError";
    this.code = code;
  }
}

export function assertSupportedInstallerPlatform(platform = process.platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new HushInstallError(
      "HUSH_INSTALL_UNSUPPORTED_PLATFORM",
      `managed local install supports macOS and Linux; found ${platform}`,
    );
  }
}

export function assertInstallerPrerequisites({
  platform = process.platform,
  nodeVersion = process.version,
  resolveTools = () => ({
    compilerPath: resolveSystemExecutable("C compiler", ["cc", "clang", "gcc"], true),
    gitPath: resolveSystemExecutable("Git", ["git"], true),
  }),
} = {}) {
  assertSupportedInstallerPlatform(platform);
  try {
    assertNode24(nodeVersion);
  } catch (error) {
    throw new HushInstallError("HUSH_INSTALL_MISSING_PREREQUISITE", error.message);
  }
  try {
    resolveTools();
  } catch (error) {
    throw new HushInstallError(
      "HUSH_INSTALL_MISSING_PREREQUISITE",
      `managed local install requires trusted Git and C compiler executables: ${error.message}`,
    );
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function configuredDirectory(label, configured, fallback) {
  const value = configured || fallback;
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  const candidate = resolve(value);
  if (candidate === parse(candidate).root) {
    throw new Error(`${label} must not be a filesystem root: ${candidate}`);
  }
  return candidate;
}

function pathsOverlap(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function requireExecutablePath(label, candidate, allowRootOwnedHardlinks = false) {
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error(`${label} path must be absolute: ${candidate || "(missing)"}`);
  }
  const canonical = realpathSync(candidate);
  const metadata = lstatSync(canonical);
  const linksAreSafe = metadata.nlink === 1 || (allowRootOwnedHardlinks && metadata.uid === 0);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !linksAreSafe ||
    !(metadata.mode & 0o111)
  ) {
    throw new Error(`${label} must be a trusted executable regular file: ${canonical}`);
  }
  return canonical;
}

const systemExecutableDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function resolveSystemExecutable(
  label,
  names,
  allowRootOwnedHardlinks = false,
  {
    directories = systemExecutableDirectories,
    pathExists = existsSync,
    canonicalize = realpathSync,
    inspect = lstatSync,
  } = {},
) {
  let lastError;
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (!pathExists(candidate)) continue;
      try {
        const canonical = canonicalize(candidate);
        const metadata = inspect(canonical);
        const linksAreSafe =
          metadata.nlink === 1 || (allowRootOwnedHardlinks && metadata.uid === 0);
        if (
          metadata.uid !== 0 ||
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          !linksAreSafe ||
          !(metadata.mode & 0o111)
        ) {
          throw new Error(`${label} must be a root-owned executable regular file: ${canonical}`);
        }
        return canonical;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error(`${label} was not found in trusted system directories`);
}

function gitEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return env;
}

function resolveBunExecutable(expectedVersion) {
  const candidates = [];
  if (process.env.HUSH_INSTALL_BUN_PATH) candidates.push(process.env.HUSH_INSTALL_BUN_PATH);

  const marker = `${sep}installs${sep}node${sep}`;
  const markerIndex = process.execPath.indexOf(marker);
  if (markerIndex >= 0) {
    candidates.push(
      join(
        process.execPath.slice(0, markerIndex),
        "installs",
        "bun",
        expectedVersion,
        "bin",
        "bun",
      ),
    );
  }

  const accountHome = userInfo().homedir;
  candidates.push(
    join(accountHome, ".local", "share", "mise", "installs", "bun", expectedVersion, "bin", "bun"),
    join(accountHome, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  );

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const executable = requireExecutablePath("Hush installer Bun", candidate);
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: 30_000,
    }).trim();
    if (version === expectedVersion) return executable;
  }
  throw new Error(
    `Hush installer requires bun@${expectedVersion} at a managed absolute path. ` +
      "Set HUSH_INSTALL_BUN_PATH to the Bun executable.",
  );
}

function resolveToolPaths(guarded) {
  if (guarded) {
    return {
      bunPath: requireExecutablePath("Pinned Hush installer Bun", process.env[pinnedBunEnv]),
      gitPath: requireExecutablePath("Pinned Hush installer Git", process.env[pinnedGitEnv], true),
    };
  }
  const packageManager = readJson(join(root, "package.json")).packageManager;
  const expectedBunVersion = /^bun@(.+)$/.exec(packageManager)?.[1];
  if (!expectedBunVersion)
    throw new Error(`Hush installer requires a pinned Bun packageManager: ${packageManager}`);
  return {
    bunPath: resolveBunExecutable(expectedBunVersion),
    gitPath: resolveSystemExecutable("Hush installer Git", ["git"], true),
  };
}

function currentGitPath() {
  const guarded = process.env.HUSH_INSTALL_NATIVE_GUARDED === "1";
  return guarded
    ? requireExecutablePath("Pinned Hush installer Git", process.env[pinnedGitEnv], true)
    : resolveSystemExecutable("Hush installer Git", ["git"], true);
}

function guardedEnvironment(config) {
  const env = gitEnvironment();
  delete env.HUSH_INSTALL_BUN_PATH;
  delete env[pinnedBunEnv];
  delete env[pinnedGitEnv];
  delete env[loginNativeHelperEnv];
  env[pinnedBunEnv] = config.bunPath;
  env[pinnedGitEnv] = config.gitPath;
  env.NODE_OPTIONS = "";
  env.NODE_PATH = "";
  env.PATH = [
    ...new Set([
      dirname(config.bunPath),
      dirname(process.execPath),
      dirname(config.gitPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
  return env;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function relativeManifestPath(runtimePath, path) {
  return relative(runtimePath, path).split(sep).join("/");
}

function requireRealDirectory(path, label = "Hush runtime root") {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`Hush runtime incomplete: ${path}. Remove it and reinstall.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return realpathSync(path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Hush runtime JSON invalid: ${path}: ${error.message}`);
  }
}

function assertInputPath(inputRoot, relativePath, expectedType) {
  const components = relativePath.split("/");
  let current = inputRoot;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      throw new Error(`Hush runtime input is missing: ${current}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Hush runtime input symlink is forbidden: ${current}`);
    }
    const leaf = index === components.length - 1;
    if (!leaf && !metadata.isDirectory()) {
      throw new Error(`Hush runtime input ancestor must be a directory: ${current}`);
    }
    if (leaf && expectedType === "file" && !metadata.isFile()) {
      throw new Error(`Hush runtime input must be a regular file: ${current}`);
    }
    if (leaf && expectedType === "directory" && !metadata.isDirectory()) {
      throw new Error(`Hush runtime input must be a real directory: ${current}`);
    }
  }
}

function assertRuntimeInputs(inputRoot) {
  const canonicalInputRoot = requireRealDirectory(inputRoot, "Hush runtime input root");
  for (const path of trackedSourcePaths) assertInputPath(canonicalInputRoot, path, "file");

  const buildRelativePath = join("hush-cli", "dist");
  assertInputPath(canonicalInputRoot, buildRelativePath, "directory");
  const buildRoot = join(canonicalInputRoot, buildRelativePath);
  const pending = [buildRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Hush runtime input symlink is forbidden: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile())
        throw new Error(`Hush runtime input type is unsupported: ${path}`);
    }
  }
  return canonicalInputRoot;
}

function collectRuntimeEntries(candidate, hashContents = true) {
  const runtimePath = requireRealDirectory(candidate);
  const entries = [
    {
      path: ".",
      type: "directory",
      mode: lstatSync(runtimePath).mode & 0o7777,
    },
  ];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const relativePath = relativeManifestPath(runtimePath, path);
      if (relativePath === manifestName) continue;

      const metadata = lstatSync(path);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        let resolvedPath;
        try {
          resolvedPath = realpathSync(path);
        } catch {
          throw new Error(`Hush runtime symlink is broken: ${relativePath}`);
        }
        if (!isInside(runtimePath, resolvedPath)) {
          throw new Error(
            `Hush runtime symlink escapes runtime: ${relativePath} -> ${resolvedPath}`,
          );
        }
        entries.push({
          path: relativePath,
          type: "symlink",
          mode,
          target: readlinkSync(path),
          resolved: relativeManifestPath(runtimePath, resolvedPath),
        });
      } else if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        walk(path);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1)
          throw new Error(`Hush runtime hardlink is forbidden: ${relativePath}`);
        entries.push({
          path: relativePath,
          type: "file",
          mode,
          ...(hashContents ? { sha256: fileSha256(path) } : {}),
        });
      } else {
        throw new Error(`Hush runtime contains unsupported file type: ${relativePath}`);
      }
    }
  }

  walk(runtimePath);
  const stableEntries = entries.sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of hashContents ? stableEntries : []) {
    if (entry.type !== "symlink") continue;
    const resolvedMetadata = statSync(join(runtimePath, entry.resolved));
    if (resolvedMetadata.isFile()) {
      if (resolvedMetadata.nlink !== 1) {
        throw new Error(`Hush runtime hardlink is forbidden: ${entry.resolved}`);
      }
      entry.sha256 = fileSha256(join(runtimePath, entry.resolved));
      continue;
    }
    const prefix = `${entry.resolved}/`;
    entry.sha256 = sha256(
      JSON.stringify(
        stableEntries.filter((candidateEntry) => candidateEntry.path.startsWith(prefix)),
      ),
    );
  }
  return { runtimePath, entries: stableEntries };
}

function directorySha256(path) {
  const rootPath = requireRealDirectory(path, "Hush build root");
  const entries = [
    {
      path: ".",
      type: "directory",
      mode: lstatSync(rootPath).mode & 0o7777,
    },
  ];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = join(directory, entry.name);
      const relativePath = relativeManifestPath(rootPath, entryPath);
      const metadata = lstatSync(entryPath);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        throw new Error(`Hush build input symlink is forbidden: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        walk(entryPath);
      } else if (metadata.isFile()) {
        entries.push({ path: relativePath, type: "file", mode, sha256: fileSha256(entryPath) });
      } else {
        throw new Error(`Hush build contains unsupported file type: ${relativePath}`);
      }
    }
  }

  walk(rootPath);
  return sha256(JSON.stringify(entries));
}

function dependencyGroups(packageDocument) {
  const optionalPeers = packageDocument.peerDependenciesMeta ?? {};
  const dependencies = new Map();
  for (const name of Object.keys(packageDocument.dependencies ?? {})) {
    dependencies.set(name, { kind: "dependency", name, optional: false });
  }
  for (const name of Object.keys(packageDocument.optionalDependencies ?? {})) {
    dependencies.set(name, { kind: "optional dependency", name, optional: true });
  }
  for (const name of Object.keys(packageDocument.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, {
        kind: "peer dependency",
        name,
        optional: optionalPeers[name]?.optional === true,
      });
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function findPackagePath(runtimePath, resolvedPath) {
  let directory = statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
  while (isInside(runtimePath, directory)) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) return packagePath;
    if (directory === runtimePath) break;
    directory = dirname(directory);
  }
  return undefined;
}

function findInstalledDependency(packagePath, dependencyName, runtimePath) {
  let directory = dirname(packagePath);
  while (isInside(runtimePath, directory)) {
    const dependencyPackagePath = join(
      directory,
      "node_modules",
      ...dependencyName.split("/"),
      "package.json",
    );
    if (existsSync(dependencyPackagePath)) return dependencyPackagePath;
    if (directory === runtimePath) break;
    directory = dirname(directory);
  }
  return undefined;
}

export function validateRuntimeGraph(candidate, hashContents = false) {
  const collected = collectRuntimeEntries(candidate, hashContents);
  const { runtimePath } = collected;
  const requiredEntries = new Map(collected.entries.map((entry) => [entry.path, entry.type]));
  for (const path of ["hush-cli/bin/hush.js", "hush-cli/dist/cli.js", "hush-cli/package.json"]) {
    if (requiredEntries.get(path) !== "file") {
      throw new Error(`Hush runtime incomplete: ${candidate}. Remove it and reinstall.`);
    }
  }

  const packagePath = join(runtimePath, "hush-cli", "package.json");
  const visited = new Set();
  function validatePackage(currentPackagePath) {
    const canonicalPackagePath = realpathSync(currentPackagePath);
    if (visited.has(canonicalPackagePath)) return;
    visited.add(canonicalPackagePath);

    const packageDocument = readJson(canonicalPackagePath);
    const runtimeRequire = createRequire(canonicalPackagePath);
    for (const dependency of dependencyGroups(packageDocument)) {
      let resolvedPath;
      try {
        resolvedPath = realpathSync(runtimeRequire.resolve(dependency.name));
      } catch {
        if (
          dependency.optional &&
          !findInstalledDependency(canonicalPackagePath, dependency.name, runtimePath)
        ) {
          continue;
        }
        throw new Error(
          `Hush runtime ${dependency.kind} missing: ${dependency.name} required by ${canonicalPackagePath}`,
        );
      }
      if (!isInside(runtimePath, resolvedPath)) {
        throw new Error(
          `Hush runtime ${dependency.kind} escapes runtime: ${dependency.name} -> ${resolvedPath}`,
        );
      }
      const dependencyPackagePath = findPackagePath(runtimePath, resolvedPath);
      if (!dependencyPackagePath) {
        throw new Error(
          `Hush runtime dependency package missing package.json: ${dependency.name} -> ${resolvedPath}`,
        );
      }
      validatePackage(dependencyPackagePath);
    }
  }

  validatePackage(packagePath);
  return collected;
}

function inputIdentity(inputRoot) {
  const canonicalInputRoot = assertRuntimeInputs(inputRoot);
  const trackedInputs = trackedSourcePaths.map((path) => ({
    path,
    sha256: fileSha256(join(canonicalInputRoot, path)),
  }));
  return {
    trackedInputs,
    inputsSha256: sha256(JSON.stringify(trackedInputs)),
    build: {
      path: "hush-cli/dist",
      sha256: directorySha256(join(canonicalInputRoot, "hush-cli", "dist")),
    },
    dependencies: {
      lockfile: "bun.lock",
      sha256: fileSha256(join(canonicalInputRoot, "bun.lock")),
    },
  };
}

function sourceIdentityFromInputs(sourceRoot, inputRoot) {
  const sourceWorkingDirectory = sourceRoot === "." ? "." : realpathSync(sourceRoot);
  const input = inputIdentity(inputRoot);
  const gitPath = currentGitPath();
  const env = gitEnvironment();
  const commit = execFileSync(gitPath, ["rev-parse", "HEAD"], {
    cwd: sourceWorkingDirectory,
    encoding: "utf8",
    env,
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Hush source commit is invalid: ${commit}`);
  for (const trackedInput of input.trackedInputs) {
    const committedBytes = execFileSync(gitPath, ["show", `${commit}:${trackedInput.path}`], {
      cwd: sourceWorkingDirectory,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (trackedInput.sha256 !== sha256(committedBytes)) {
      throw new Error(
        `Hush tracked shipped input differs from HEAD: ${trackedInput.path}\n` +
          "Commit or restore that input before installing a commit-attributed runtime.",
      );
    }
  }
  const currentCommit = execFileSync(gitPath, ["rev-parse", "HEAD"], {
    cwd: sourceWorkingDirectory,
    encoding: "utf8",
    env,
  }).trim();
  if (currentCommit !== commit)
    throw new Error("Hush source commit changed while reading runtime inputs.");
  return {
    tracked: {
      commit,
      tree: execFileSync(gitPath, ["rev-parse", `${commit}^{tree}`], {
        cwd: sourceWorkingDirectory,
        encoding: "utf8",
        env,
      }).trim(),
      inputsSha256: input.inputsSha256,
    },
    build: input.build,
    dependencies: input.dependencies,
  };
}

function stagedSourceIdentity(inputRoot, expectedSource) {
  const input = inputIdentity(inputRoot);
  const actual = {
    tracked: {
      ...expectedSource.tracked,
      inputsSha256: input.inputsSha256,
    },
    build: input.build,
    dependencies: input.dependencies,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expectedSource)) {
    throw new Error("Hush staged runtime inputs differ from the guarded source checkout.");
  }
  return actual;
}

export function sourceIdentity(sourceRoot = root) {
  return sourceIdentityFromInputs(sourceRoot, sourceRoot);
}

export function createRuntimeManifest(
  candidate,
  source,
  entries = collectRuntimeEntries(candidate).entries,
) {
  return {
    version: 2,
    source,
    files: entries,
  };
}

function writeRuntimeManifest(candidate, source, entries) {
  const manifestPath = join(candidate, manifestName);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(createRuntimeManifest(candidate, source, entries), null, 2)}\n`,
    { mode: 0o444, flag: "wx" },
  );
  chmodSync(manifestPath, 0o444);
}

function validateRuntimeManifest(candidate, source, currentEntries) {
  const manifestPath = join(candidate, manifestName);
  let metadata;
  try {
    metadata = lstatSync(manifestPath);
  } catch {
    throw new Error(`Hush runtime manifest missing: ${manifestPath}. Remove it and reinstall.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`Hush runtime manifest must be a single-link regular file: ${manifestPath}`);
  }
  if ((metadata.mode & 0o777) !== 0o444) {
    throw new Error(`Hush runtime manifest mode drift: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.version !== 2 || !manifest.source || !Array.isArray(manifest.files)) {
    throw new Error(`Hush runtime manifest invalid: ${manifestPath}`);
  }
  if (JSON.stringify(manifest.source) !== JSON.stringify(source)) {
    throw new Error(`Hush runtime source identity drift: ${manifestPath}`);
  }

  const current = createRuntimeManifest(candidate, source, currentEntries);
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (
    expectedByPath.size !== manifest.files.length ||
    manifest.files.some((entry) => typeof entry.path !== "string")
  ) {
    throw new Error(`Hush runtime manifest invalid: ${manifestPath}`);
  }
  const currentByPath = new Map(current.files.map((entry) => [entry.path, entry]));
  for (const [path, expected] of expectedByPath) {
    const actual = currentByPath.get(path);
    if (!actual) throw new Error(`Hush runtime manifest drift: missing ${path}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Hush runtime manifest drift: changed ${path}`);
    }
  }
  for (const path of currentByPath.keys()) {
    if (!expectedByPath.has(path))
      throw new Error(`Hush runtime manifest drift: unexpected ${path}`);
  }
}

function validateManagedRuntime(candidate, source) {
  const collected = validateRuntimeGraph(candidate, true);
  validateRuntimeManifest(candidate, source, collected.entries);
}

function compileNativeProgram(compiler, source, output, label) {
  const result = spawnSync(
    compiler,
    ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-x", "c", "-", "-o", output],
    {
      input: source,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) {
    throw new HushInstallError(
      "HUSH_INSTALL_NATIVE_COMPILE_FAILED",
      `${label} compilation failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new HushInstallError(
      "HUSH_INSTALL_NATIVE_COMPILE_FAILED",
      `${label} compilation failed:\n${result.stderr || result.stdout}`,
    );
  }
  chmodSync(output, 0o700);
  const metadata = lstatSync(output);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file.`);
  }
}

function compileNativeHelper() {
  const compiler = resolveSystemExecutable(
    "Hush installer C compiler",
    ["cc", "clang", "gcc"],
    true,
  );
  const buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), "hush-install-native-")));
  const helperPath = join(buildDirectory, "hush-install-native");
  const loginHelperPath = join(buildDirectory, "hush-login-native");
  const source = readFileSync(join(root, "scripts", "install-local-native.c"), "utf8");
  const mainAnchor = "\nint main(int argc, char **argv) {";
  if (source.split(mainAnchor).length !== 2) {
    rmSync(buildDirectory, { recursive: true, force: true });
    throw new Error("Hush native helper main anchor is invalid.");
  }
  const loginSource = [
    source.replace(mainAnchor, `\n#define main hush_runtime_unused_main${mainAnchor}`),
    "#undef main",
    loginNativeExtension,
  ].join("\n");
  try {
    compileNativeProgram(compiler, source, helperPath, "native helper");
    compileNativeProgram(compiler, loginSource, loginHelperPath, "login native helper");
  } catch (error) {
    rmSync(buildDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: helperPath,
    loginPath: loginHelperPath,
    cleanup() {
      rmSync(buildDirectory, { recursive: true, force: true });
    },
  };
}

function requireNativeHelper(environmentKey, label) {
  const helperPath = process.env[environmentKey];
  if (!helperPath || !isAbsolute(helperPath)) {
    throw new Error(`${label} path is missing.`);
  }
  const metadata = lstatSync(helperPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !(metadata.mode & 0o111)
  ) {
    throw new Error(`${label} is not an executable single-link regular file.`);
  }
  return helperPath;
}

function assertGuardedDescriptors() {
  if (process.env.HUSH_INSTALL_NATIVE_GUARDED !== "1") {
    throw new Error("Hush installer internal mode requires the native install guard.");
  }
  for (const [label, fd] of Object.entries(guardedFds)) {
    let metadata;
    try {
      metadata = fstatSync(fd);
    } catch {
      throw new Error(`Hush installer native guard descriptor is missing: ${label}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Hush installer native guard descriptor has the wrong type: ${label}`);
    }
  }
  return requireNativeHelper("HUSH_INSTALL_NATIVE_HELPER", "Hush installer native helper");
}

function nativeStdio(stdin, stdout, stderr) {
  return [stdin, stdout, stderr, guardedFds.source, guardedFds.runtimeParent, guardedFds.bin];
}

function runNative(args, options = {}) {
  const helperPath = assertGuardedDescriptors();
  const result = spawnSync(helperPath, args, {
    input: options.input,
    encoding: options.encoding ?? "utf8",
    env: process.env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: nativeStdio(options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(
      result.stderr || result.stdout || `native helper exited ${result.status}`,
    ).trim();
    const error = new Error(message);
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

function runNativeInherited(args) {
  const helperPath = assertGuardedDescriptors();
  const result = spawnSync(helperPath, args, {
    env: process.env,
    stdio: nativeStdio("inherit", "inherit", "inherit"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Hush guarded command failed with exit ${result.status}.`);
}

function identityArgs(identity) {
  return identity ? [identity.device, identity.inode] : ["-", "-"];
}

function parseNativeIdentity(output, label) {
  const [device, inode, ...extra] = output.trim().split("\t");
  if (!device || !inode || extra.length > 0 || !/^\d+$/.test(device) || !/^\d+$/.test(inode)) {
    throw new Error(`Invalid native ${label} identity: ${output.trim()}`);
  }
  return { device, inode };
}

function runAtSource(command, args = [], capture = true) {
  const nativeArgs = ["run-at", "source", root, "-", "-", "-", command, ...args];
  return capture ? runNative(nativeArgs) : runNativeInherited(nativeArgs);
}

function runAtRuntime(runtimeParent, name, identity, command, args = [], capture = true) {
  const nativeArgs = [
    "run-at",
    "runtime",
    runtimeParent,
    name,
    ...identityArgs(identity),
    command,
    ...args,
  ];
  return capture ? runNative(nativeArgs) : runNativeInherited(nativeArgs);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function readSourceIdentity() {
  const output = runAtSource(process.execPath, [scriptPath, "--internal-source-identity"]);
  return JSON.parse(output);
}

function assertSourceCommit(config, expectedCommit) {
  const actualCommit = runAtSource(config.gitPath, ["rev-parse", "HEAD"]).trim();
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Hush source commit changed during install: expected ${expectedCommit}, found ${actualCommit}.`,
    );
  }
}

function validateRuntimeThroughGuard(runtimeParent, runtimeName, runtimeIdentity, source) {
  runAtRuntime(runtimeParent, runtimeName, runtimeIdentity, process.execPath, [
    scriptPath,
    "--internal-validate-runtime",
    encodeJson(source),
  ]);
}

function runtimeEntryInfo(runtimeParent, runtimeName) {
  const output = runNative(["entry-kind", runtimeParent, runtimeName]).trim();
  if (output === "missing") return { kind: "missing", identity: undefined };
  const [kind, device, inode, ...extra] = output.split("\t");
  if (
    extra.length > 0 ||
    !["directory", "symlink", "file", "other"].includes(kind) ||
    !/^\d+$/.test(device) ||
    !/^\d+$/.test(inode)
  ) {
    throw new Error(`Invalid native runtime entry: ${output}`);
  }
  return { kind, identity: { device, inode } };
}

function listRuntimeEntries(runtimeParent) {
  const output = runNative(["list-runtimes", runtimeParent]).trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 6) throw new Error(`Invalid native runtime listing: ${line}`);
    const [kind, secondsText, nanosecondsText, device, inode, name] = fields;
    const seconds = Number(secondsText);
    const nanoseconds = Number(nanosecondsText);
    if (
      !["R", "S", "P", "X"].includes(kind) ||
      !name ||
      !Number.isFinite(seconds) ||
      !Number.isFinite(nanoseconds) ||
      !/^\d+$/.test(device) ||
      !/^\d+$/.test(inode)
    ) {
      throw new Error(`Invalid native runtime listing: ${line}`);
    }
    return {
      kind,
      name,
      identity: { device, inode },
      modified: seconds * 1000 + nanoseconds / 1_000_000,
    };
  });
}

function checkRoots(config) {
  runNative(["check-roots", root, config.runtimeParent, config.binDir]);
}

function cleanupStaleArtifacts(config, checkOnly) {
  const entries = listRuntimeEntries(config.runtimeParent);
  const unsafe = entries.find((entry) => entry.kind === "X");
  if (unsafe)
    throw new Error(`Hush managed runtime entry is symlinked or not a directory: ${unsafe.name}`);
  const stale = entries.filter((entry) => entry.kind === "S" || entry.kind === "P");
  if (checkOnly && stale.length > 0) {
    throw new Error(
      `Hush install has stale unpublished artifacts: ${stale.map((entry) => entry.name).join(", ")}`,
    );
  }
  for (const entry of stale) {
    runNative(["remove-stale", config.runtimeParent, entry.name, ...identityArgs(entry.identity)]);
  }
  if (!checkOnly) runNative(["cleanup-bin", config.binDir]);
}

function validateLauncher(config, launcher) {
  const actual = runNative(["read-launcher", config.binDir, "hush"]);
  if (actual !== launcher) {
    throw new Error(
      `Hush launcher drift: ${config.target}. Re-run \`node scripts/install-local.mjs\`.`,
    );
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function loginShellDetails(account = userInfo()) {
  const shell = requireExecutablePath("Hush account login shell", account.shell || "/bin/sh", true);
  return {
    account,
    shell,
    args: basename(shell) === "zsh" ? ["-lic"] : ["-lc"],
  };
}

function coldLoginEnvironment(details) {
  const environment = {
    HOME: homedir(),
    USER: details.account.username,
    LOGNAME: details.account.username,
    SHELL: details.shell,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HUSH_NO_UPDATE_CHECK: "1",
  };
  if (process.env.ZDOTDIR !== undefined) environment.ZDOTDIR = process.env.ZDOTDIR;
  return environment;
}

function sanitizedDiagnostic(value, fallback) {
  const sanitized = String(value || "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return sanitized || fallback;
}

function safeProbeField(value) {
  return value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}

function loginProbeFailure(details, args, reason) {
  return {
    kind: "failure",
    shell: details.shell,
    invocation: args.join(" "),
    reason,
  };
}

function runLoginProbe(details, args, command, marker) {
  const result = spawnSync(details.shell, [...args, command], {
    env: coldLoginEnvironment(details),
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0) {
    return loginProbeFailure(
      details,
      args,
      sanitizedDiagnostic(
        result.error?.message ||
          (result.signal ? `signal ${result.signal}` : `exit ${result.status}`),
        "unknown shell failure",
      ),
    );
  }
  let stdout;
  try {
    stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    return loginProbeFailure(details, args, "login shell returned invalid UTF-8 metadata");
  }
  const markerLines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (markerLines.length !== 1) {
    return loginProbeFailure(details, args, "login shell returned invalid resolution metadata");
  }
  const fields = markerLines[0].slice(marker.length).split("\t");
  if (fields.length !== 4 || fields.some((field) => !safeProbeField(field))) {
    return loginProbeFailure(details, args, "login shell returned invalid resolution metadata");
  }
  const [shellKind, zdotdirSet, zdotdir, rawResolved] = fields;
  if (!["zsh", "bash", "other"].includes(shellKind)) {
    return loginProbeFailure(details, args, "login shell identity is unsupported");
  }
  if (!["0", "1"].includes(zdotdirSet)) {
    return loginProbeFailure(details, args, "login shell returned invalid ZDOTDIR metadata");
  }
  return { shellKind, zdotdirSet: zdotdirSet === "1", zdotdir, rawResolved };
}

function zshStartupPath(zdotdirSet, zdotdir) {
  const home = resolve(homedir());
  if (zdotdirSet && !zdotdir) {
    throw new Error("ZDOTDIR must not be empty.");
  }
  const configured = zdotdirSet ? zdotdir : home;
  if (!isAbsolute(configured)) {
    throw new Error(`ZDOTDIR must be absolute: ${configured}`);
  }
  const directory = resolve(configured);
  if (!isInside(home, directory)) {
    throw new Error(`ZDOTDIR must stay within HOME: ${directory}`);
  }
  const canonical = realpathSync(directory);
  if (canonical !== directory) {
    throw new Error(`ZDOTDIR must not contain symlinked path components: ${directory}`);
  }
  const metadata = lstatSync(directory, { bigint: true });
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o22n) !== 0n
  ) {
    throw new Error(`ZDOTDIR must be a user-owned non-writable-by-others directory: ${directory}`);
  }
  return join(directory, ".zlogin");
}

function probeLoginShell(config) {
  checkRoots(config);
  let details;
  try {
    details = loginShellDetails();
  } catch (error) {
    return {
      kind: "failure",
      shell: "account login shell",
      invocation: "login",
      reason: sanitizedDiagnostic(error.message, "invalid account login shell"),
    };
  }
  const marker = `__HUSH_LOGIN_${randomBytes(12).toString("hex")}__`;
  const command = [
    'if [ -n "${ZSH_VERSION-}" ]; then _hush_shell=zsh',
    'elif [ -n "${BASH_VERSION-}" ]; then _hush_shell=bash',
    "else _hush_shell=other",
    "fi",
    'if [ "${ZDOTDIR+x}" = x ]; then _hush_zdotdir_set=1; else _hush_zdotdir_set=0; fi',
    `printf '${marker}%s\\t%s\\t%s\\t%s\\n' "$_hush_shell" "$_hush_zdotdir_set" "\${ZDOTDIR-}" ` +
      '"$(command -v hush 2>/dev/null || true)"',
  ].join("; ");
  let args = details.args;
  let parsed = runLoginProbe(details, args, command, marker);
  if (parsed.kind === "failure") return parsed;
  if (parsed.shellKind === "zsh" && args[0] !== "-lic") {
    args = ["-lic"];
    parsed = runLoginProbe(details, args, command, marker);
    if (parsed.kind === "failure") return parsed;
  }
  const { shellKind, zdotdirSet, zdotdir, rawResolved } = parsed;
  let startupPath;
  if (shellKind === "zsh") {
    try {
      startupPath = zshStartupPath(zdotdirSet, zdotdir);
    } catch (error) {
      return {
        kind: "failure",
        shell: details.shell,
        invocation: args.join(" "),
        shellKind,
        reason: sanitizedDiagnostic(error.message, "invalid zsh startup directory"),
      };
    }
  }
  const common = {
    shell: details.shell,
    invocation: args.join(" "),
    shellKind,
    startupPath,
  };
  if (rawResolved !== rawResolved.trim()) {
    return {
      kind: "failure",
      reason: "login shell resolved a path with unsafe surrounding whitespace",
      ...common,
    };
  }
  const resolved = rawResolved;
  if (!resolved) {
    return { kind: "missing", ...common };
  }
  if (!isAbsolute(resolved)) {
    return { kind: "relative", resolved, ...common };
  }

  const helperPath = assertGuardedDescriptors();
  const comparison = spawnSync(helperPath, ["same-launcher", config.binDir, "hush", resolved], {
    encoding: "utf8",
    env: process.env,
    stdio: nativeStdio("ignore", "pipe", "pipe"),
  });
  if (comparison.error || comparison.signal) {
    return {
      kind: "unusable",
      resolved,
      reason: sanitizedDiagnostic(
        comparison.error?.message || `signal ${comparison.signal}`,
        "launcher comparison failed",
      ),
      ...common,
    };
  }
  if (comparison.status === 0) {
    checkRoots(config);
    return { kind: "delivered", resolved, ...common };
  }
  if (comparison.status !== 3) {
    return {
      kind: "unusable",
      resolved,
      reason: sanitizedDiagnostic(
        comparison.stderr,
        `launcher comparison exited ${comparison.status}`,
      ),
      ...common,
    };
  }
  return { kind: "shadowed", resolved, ...common };
}

function reportLoginShellFailure(config, probe) {
  const shell = sanitizedDiagnostic(probe.shell, "unknown shell");
  const invocation = sanitizedDiagnostic(probe.invocation, "login invocation");
  const resolved = sanitizedDiagnostic(probe.resolved, "unprintable path");
  const binDir = sanitizedDiagnostic(config.binDir, "configured bin directory");
  const target = sanitizedDiagnostic(config.target, "installed launcher");
  if (probe.kind === "failure") {
    console.error(
      `hush: installed ${target}, but login shell resolution failed ` +
        `(${shell} ${invocation}): ${probe.reason}. This install is not delivered.`,
    );
    return;
  }
  if (probe.kind === "missing") {
    console.error(
      `hush: installed ${target}, but a login shell (${shell} ${invocation}) ` +
        `resolves no hush at all -- ${binDir} is missing from the login PATH, ` +
        "so this install is not delivered.",
    );
    return;
  }
  if (probe.kind === "relative") {
    console.error(`hush: login shell resolved a non-absolute hush path: ${resolved}`);
    return;
  }
  if (probe.kind === "unusable") {
    console.error(`hush: login shell resolved unusable hush path: ${resolved} (${probe.reason}).`);
    return;
  }
  console.error(
    `hush: SHADOWED INSTALL. Installed ${target}, but a login shell resolves ${resolved} first.\n` +
      `hush is the secrets front door: every interactive shell would keep using that other copy, ` +
      `and this installer does not upgrade it.\n` +
      `Fix the shadow (for a global npm copy: npm uninstall -g @chriscode/hush), or put ${binDir} ` +
      `ahead of it on the login PATH, then re-run.\n` +
      `Set HUSH_INSTALL_SKIP_SHADOW_CHECK=1 to bypass deliberately.`,
  );
}

function sameShellStartupState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

const shellStartupStateFields = [
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
];

function parseShellStartupState(fields) {
  if (
    fields.length !== shellStartupStateFields.length ||
    fields.some((field, index) => {
      const signed =
        shellStartupStateFields[index] === "mtimeNs" ||
        shellStartupStateFields[index] === "ctimeNs";
      return !(signed ? /^-?\d+$/ : /^\d+$/).test(field);
    })
  ) {
    throw new Error("Hush login native helper returned an invalid publication receipt.");
  }
  return Object.fromEntries(
    shellStartupStateFields.map((field, index) => [field, BigInt(fields[index])]),
  );
}

function parseLoginPublicationReceipt(output, expectedOriginal) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error("Hush login native helper returned a non-UTF-8 publication receipt.");
  }
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("Hush login native helper returned an unterminated publication receipt.");
  }
  lines.pop();
  if (lines.length !== 2) {
    throw new Error("Hush login native helper returned an invalid publication receipt.");
  }
  const published = lines[0].split("\t");
  const original = lines[1].split("\t");
  if (
    published.shift() !== "published" ||
    original.shift() !== "original" ||
    (expectedOriginal
      ? original.length !== shellStartupStateFields.length
      : original.join("\t") !== "-")
  ) {
    throw new Error("Hush login native helper returned an invalid publication receipt.");
  }
  return {
    published: parseShellStartupState(published),
    original: expectedOriginal ? parseShellStartupState(original) : undefined,
  };
}

function shellStartupStateArgs(state) {
  return shellStartupStateFields.map((field) => String(state[field]));
}

function sameShellDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function readShellStartupFile(path) {
  const parent = dirname(path);
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) {
    throw new Error(`Hush login startup directory must not be symlinked: ${parent}`);
  }
  const parentMetadata = lstatSync(parent, { bigint: true });
  const uid = process.getuid?.();
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (uid !== undefined && parentMetadata.uid !== BigInt(uid)) ||
    (parentMetadata.mode & 0o22n) !== 0n
  ) {
    throw new Error(`Hush login startup directory is unsafe: ${parent}`);
  }
  const parentFd = openSync(
    parent,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedParent = fstatSync(parentFd, { bigint: true });
    const finalParent = lstatSync(parent, { bigint: true });
    if (
      !sameShellDirectoryIdentity(parentMetadata, openedParent) ||
      !sameShellDirectoryIdentity(openedParent, finalParent) ||
      realpathSync(parent) !== parent
    ) {
      throw new Error(`Hush login startup directory changed while opening: ${parent}`);
    }
    let pathMetadata;
    try {
      pathMetadata = lstatSync(path, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const absentParent = lstatSync(parent, { bigint: true });
      if (
        !sameShellDirectoryIdentity(openedParent, absentParent) ||
        realpathSync(parent) !== parent
      ) {
        throw new Error(`Hush login startup directory changed while reading: ${parent}`);
      }
      return {
        exists: false,
        content: Buffer.alloc(0),
        fd: undefined,
        parentFd,
        state: undefined,
      };
    }
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1n) {
      throw new Error(`Hush login startup file must be a single-link regular file: ${path}`);
    }
    if (uid !== undefined && pathMetadata.uid !== BigInt(uid)) {
      throw new Error(`Hush login startup file must be owned by the current user: ${path}`);
    }
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      const content = readFileSync(fd);
      const afterRead = fstatSync(fd, { bigint: true });
      const finalPath = lstatSync(path, { bigint: true });
      const afterParent = lstatSync(parent, { bigint: true });
      if (
        !sameShellStartupState(pathMetadata, opened) ||
        !sameShellStartupState(opened, afterRead) ||
        !sameShellStartupState(afterRead, finalPath) ||
        !sameShellDirectoryIdentity(openedParent, afterParent) ||
        realpathSync(parent) !== parent
      ) {
        throw new Error(`Hush login startup file changed while reading: ${path}`);
      }
      return {
        exists: true,
        content,
        fd,
        parentFd,
        state: afterRead,
      };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } catch (error) {
    closeSync(parentFd);
    throw error;
  }
}

function closeShellStartupFile(snapshot) {
  if (!snapshot) return;
  if (snapshot.fd !== undefined) {
    closeSync(snapshot.fd);
    snapshot.fd = undefined;
  }
  if (snapshot.parentFd !== undefined) {
    closeSync(snapshot.parentFd);
    snapshot.parentFd = undefined;
  }
}

function splitStartupLines(content) {
  const lines = [];
  for (let offset = 0; offset < content.length;) {
    const newline = content.indexOf("\n", offset);
    const end = newline === -1 ? content.length : newline + 1;
    const raw = content.slice(offset, end);
    const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    const body = raw.slice(0, raw.length - ending.length);
    if (body.includes("\r")) {
      throw new Error("Hush login startup file uses unsupported bare carriage returns.");
    }
    lines.push({ raw, body });
    offset = end;
  }
  return lines;
}

function isManagedPathExport(line) {
  const prefix = "export PATH=";
  const suffix = ':"$PATH"';
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const quoted = line.slice(prefix.length, -suffix.length);
  return /^'(?:[^']|'\\'')*'$/.test(quoted);
}

function renderLoginPathBlock(content, binDir) {
  if (/[\x00\r\n]/.test(binDir)) {
    throw new Error(`Hush bin root is not shell-safe: ${binDir}`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new Error("Hush login startup file is not valid UTF-8; refusing replacement.");
  }
  if (!Buffer.from(text, "utf8").equals(content)) {
    throw new Error("Hush login startup file does not round-trip as UTF-8; refusing replacement.");
  }
  const lines = splitStartupLines(text);
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].body === loginPathBlockStart) starts.push(index);
    if (lines[index].body === loginPathBlockEnd) ends.push(index);
  }
  if (starts.length !== ends.length || starts.length > 1) {
    throw new Error("Hush managed login PATH block is malformed; repair it before reinstalling.");
  }
  let base = text;
  if (starts.length === 1) {
    const start = starts[0];
    const end = ends[0];
    if (
      end !== start + 3 ||
      lines[start + 1]?.body !== "# Managed by Hush scripts/install-local.mjs." ||
      !isManagedPathExport(lines[start + 2]?.body || "")
    ) {
      throw new Error("Hush managed login PATH block is malformed; repair it before reinstalling.");
    }
    base = lines
      .filter((_, index) => index < start || index > end)
      .map((line) => line.raw)
      .join("");
  }
  base = base.replace(/(?:\r?\n)*$/, "");
  const block = [
    loginPathBlockStart,
    "# Managed by Hush scripts/install-local.mjs.",
    `export PATH=${shellQuote(binDir)}:"$PATH"`,
    loginPathBlockEnd,
    "",
  ].join("\n");
  return Buffer.from(`${base}${base ? "\n\n" : ""}${block}`, "utf8");
}

function runLoginNative(args, input, expected, metadataSource) {
  const helperPath = requireNativeHelper(
    loginNativeHelperEnv,
    "Hush installer login native helper",
  );
  const result = spawnSync(helperPath, args, {
    input,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [
      "pipe",
      "pipe",
      "pipe",
      expected?.fd ?? "ignore",
      metadataSource?.fd ?? "ignore",
      expected?.parentFd ?? metadataSource?.parentFd ?? "ignore",
    ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      sanitizedDiagnostic(
        result.stderr || result.stdout,
        `login native helper exited ${result.status}`,
      ),
    );
  }
  if (result.stderr?.length) {
    console.error(`hush: ${sanitizedDiagnostic(result.stderr, "login native helper warning")}`);
  }
  return result.stdout;
}

function preserveShellStartupOriginal(path, original, state, metadataSource, firstRecovery) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const recovery =
      attempt === 0
        ? firstRecovery
        : `.hush-login-recovery-${process.pid}-${randomBytes(16).toString("hex")}`;
    try {
      runLoginNative(
        [
          "login-preserve",
          dirname(path),
          recovery,
          String(original.content.length),
          "644",
          ...shellStartupStateArgs(state),
        ],
        original.content,
        original,
        metadataSource,
      );
      return join(dirname(path), recovery);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function recoverShellStartupReadback(path, expected, content, metadataSource, receipt) {
  let current;
  let recoveryError;
  try {
    current = readShellStartupFile(path);
    if (
      current.exists &&
      current.content.equals(content) &&
      sameShellStartupState(current.state, receipt.published)
    ) {
      if (expected.exists) {
        writeShellStartupFile(path, current, expected.content, metadataSource, false);
      } else {
        removeShellStartupFile(path, current);
      }
      return { kind: "restored" };
    }
  } catch (error) {
    recoveryError = error;
  } finally {
    closeShellStartupFile(current);
  }

  if (!expected.exists) {
    return {
      kind: "preserved-target",
      reason: sanitizedDiagnostic(recoveryError?.message, "published startup identity changed"),
    };
  }
  try {
    return {
      kind: "preserved-original",
      recoveryPath: preserveShellStartupOriginal(
        path,
        expected,
        receipt.original,
        metadataSource,
        `.hush-login-recovery-${process.pid}-${randomBytes(16).toString("hex")}`,
      ),
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: sanitizedDiagnostic(error.message, "startup recovery failed"),
    };
  }
}

function writeShellStartupFile(
  path,
  expected,
  content,
  metadataSource = expected,
  verifyReadback = true,
) {
  const temporary = `.hush-login-${process.pid}-${randomBytes(12).toString("hex")}`;
  const recovery = `.hush-login-${process.pid}-${randomBytes(12).toString("hex")}`;
  const receipt = parseLoginPublicationReceipt(
    runLoginNative(
      [
        "login-write",
        dirname(path),
        basename(path),
        temporary,
        recovery,
        expected.exists ? "1" : "0",
        String(expected.content.length),
        String(content.length),
        "644",
      ],
      Buffer.concat([expected.content, content]),
      expected,
      metadataSource?.exists ? metadataSource : undefined,
    ),
    expected.exists,
  );
  if (!verifyReadback) return undefined;
  pauseForRaceTest("before-login-readback");
  let installed;
  try {
    if (process.env.HUSH_INSTALL_TEST_FAIL_LOGIN_READBACK === "1") {
      delete process.env.HUSH_INSTALL_TEST_FAIL_LOGIN_READBACK;
      throw new Error("Hush login startup file test read-back failure.");
    }
    installed = readShellStartupFile(path);
    if (
      !installed.exists ||
      !installed.content.equals(content) ||
      !sameShellStartupState(installed.state, receipt.published)
    ) {
      throw new Error(`Hush login startup file read-back failed: ${path}`);
    }
    return installed;
  } catch (error) {
    closeShellStartupFile(installed);
    const recovered = recoverShellStartupReadback(path, expected, content, metadataSource, receipt);
    const reason = sanitizedDiagnostic(error.message, "startup read-back failed");
    if (recovered.kind === "restored") {
      throw new Error(`${reason} Original startup state restored.`);
    }
    if (recovered.kind === "preserved-original") {
      throw new Error(
        `${reason} Changed startup target preserved; original preserved at ` +
          `${sanitizedDiagnostic(recovered.recoveryPath, "startup recovery file")}.`,
      );
    }
    if (recovered.kind === "preserved-target") {
      throw new Error(
        `${reason} Changed startup target preserved; original absence not overwritten ` +
          `(${recovered.reason}).`,
      );
    }
    throw new Error(`${reason} Startup recovery failed: ${recovered.reason}.`);
  }
}

function removeShellStartupFile(path, expected) {
  const quarantine = `.hush-login-${process.pid}-${randomBytes(12).toString("hex")}`;
  runLoginNative(
    ["login-remove", dirname(path), basename(path), quarantine, String(expected.content.length)],
    expected.content,
    expected,
    undefined,
  );
}

function installZshLoginPath(config, probe) {
  if (probe.shellKind !== "zsh" || !probe.startupPath) return undefined;
  const path = probe.startupPath;
  const original = readShellStartupFile(path);
  try {
    const installedContent = renderLoginPathBlock(original.content, config.binDir);
    if (original.exists && original.content.equals(installedContent)) {
      return {
        path,
        rollback() {},
        close() {
          closeShellStartupFile(original);
        },
      };
    }
    const installed = writeShellStartupFile(path, original, installedContent);
    return {
      path,
      rollback() {
        if (original.exists) {
          writeShellStartupFile(path, installed, original.content, original, false);
        } else {
          removeShellStartupFile(path, installed);
        }
      },
      close() {
        closeShellStartupFile(installed);
        closeShellStartupFile(original);
      },
    };
  } catch (error) {
    closeShellStartupFile(original);
    throw error;
  }
}

function ensureLoginShellDelivery(config, checkOnly) {
  if (process.env.HUSH_INSTALL_SKIP_SHADOW_CHECK === "1") return false;
  let probe = probeLoginShell(config);
  if (probe.kind === "delivered") return false;
  if (checkOnly) {
    reportLoginShellFailure(config, probe);
    return true;
  }

  const change = installZshLoginPath(config, probe);
  if (change) {
    const expectedStartupPath = change.path;
    try {
      probe = probeLoginShell(config);
      if (probe.kind === "delivered" && probe.startupPath === expectedStartupPath) {
        return false;
      }
      if (probe.kind === "delivered") {
        probe = {
          ...probe,
          kind: "failure",
          reason: "zsh startup directory changed during install",
        };
      }
      change.rollback();
    } finally {
      change.close();
    }
  }
  if (probe.shellKind && probe.shellKind !== "zsh") {
    const binDir = sanitizedDiagnostic(config.binDir, "configured bin directory");
    console.error(
      `hush: ${probe.shellKind} login startup is not managed automatically; ` +
        `put ${binDir} first on PATH and re-run.`,
    );
  }
  reportLoginShellFailure(config, probe);
  return true;
}

function validateToolchain(config) {
  const builtCli = join(root, "hush-cli", "dist", "cli.js");
  if (!existsSync(builtCli)) {
    throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
  }
  assertNode24(process.version);
  const packageManager = readJson(join(root, "package.json")).packageManager;
  const expectedBunVersion = /^bun@(.+)$/.exec(packageManager)?.[1];
  const actualBunVersion = execFileSync(config.bunPath, ["--version"], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: 30_000,
  }).trim();
  if (!expectedBunVersion || actualBunVersion !== expectedBunVersion) {
    throw new Error(`Hush installer requires ${packageManager}; found bun@${actualBunVersion}.`);
  }
}

function pauseForRaceTest(point) {
  if (process.env.HUSH_INSTALL_TEST_PAUSE_AT !== point) return;
  const marker = process.env.HUSH_INSTALL_TEST_PAUSE_MARKER;
  const release = process.env.HUSH_INSTALL_TEST_PAUSE_RELEASE;
  if (!marker || !release)
    throw new Error("Hush installer test pause requires marker and release paths.");
  writeFileSync(marker, `${process.pid}\n`, { flag: "wx" });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 20);
}

function resolveManagedConfig(guarded = false) {
  const tools = resolveToolPaths(guarded);
  const commit = execFileSync(tools.gitPath, ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment(),
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Hush source commit is invalid: ${commit}`);
  const defaultRuntimeRoot = join(homedir(), ".local", "state", "hush", "runtimes", commit);
  const configuredRuntimeRoot = process.env.HUSH_INSTALL_RUNTIME_ROOT;
  const runtimeRoot = configuredDirectory(
    "Hush runtime root",
    configuredRuntimeRoot,
    defaultRuntimeRoot,
  );
  if (pathsOverlap(runtimeRoot, root)) {
    throw new Error(
      "Hush managed runtime must not overlap the mutable source checkout. " +
        "Omit HUSH_INSTALL_RUNTIME_ROOT for the immutable default, or use --source-checkout for validation only.",
    );
  }
  const binDir = configuredDirectory(
    "Hush bin root",
    process.env.HUSH_INSTALL_BIN_DIR,
    join(homedir(), ".local", "bin"),
  );
  const runtimeName = basename(runtimeRoot);
  if (runtimeName.startsWith(".hush-stage-") || runtimeName.startsWith(".hush-prune-")) {
    throw new Error(`Hush runtime root uses a reserved managed name: ${runtimeRoot}`);
  }
  if (runtimeName !== commit) {
    throw new Error(
      `Hush managed runtime root must end with the source commit ${commit}: ${runtimeRoot}`,
    );
  }
  if (pathsOverlap(binDir, root)) {
    throw new Error(`Hush bin root must not overlap the mutable source checkout: ${binDir}`);
  }
  if (pathsOverlap(binDir, runtimeRoot)) {
    throw new Error(`Hush bin root must not overlap the managed runtime: ${binDir}`);
  }
  return {
    runtimeRoot,
    runtimeParent: dirname(runtimeRoot),
    runtimeName,
    expectedCommit: commit,
    runtimeEntrypoint: join(runtimeRoot, "hush-cli", "bin", "hush.js"),
    binDir,
    target: join(binDir, "hush"),
    ...tools,
  };
}

function parsePublicOptions(args) {
  const allowed = new Set(["--check", "--source-checkout"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown Hush installer option: ${unknown[0]}`);
  return {
    checkOnly: args.includes("--check"),
    sourceCheckout: args.includes("--source-checkout"),
  };
}

function runSourceCheckoutMode(options) {
  if (process.env.HUSH_INSTALL_RUNTIME_ROOT) {
    throw new Error("--source-checkout cannot be combined with HUSH_INSTALL_RUNTIME_ROOT.");
  }
  validateToolchain(resolveToolPaths(false));
  sourceIdentity();
  const execution = spawnSync(
    process.execPath,
    [join(root, "hush-cli", "bin", "hush.js"), "--version"],
    {
      cwd: root,
      env: {
        ...gitEnvironment(),
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
      encoding: "utf8",
    },
  );
  if (execution.status !== 0) {
    throw new Error(
      `Hush source checkout launcher failed:\n${execution.stderr || execution.stdout}`,
    );
  }
  console.log(join(root, "hush-cli", "bin", "hush.js"));
  if (!options.checkOnly) {
    console.error("hush: source-checkout validation complete; managed launcher unchanged.");
  }
}

function runGuardedInstaller(config, publicArgs) {
  const compiled = compileNativeHelper();
  try {
    const result = spawnSync(
      compiled.path,
      [
        "guard",
        publicArgs.includes("--check") ? "check" : "install",
        root,
        config.runtimeParent,
        config.binDir,
        process.execPath,
        scriptPath,
        "--internal-guarded",
        ...publicArgs,
      ],
      {
        env: {
          ...guardedEnvironment(config),
          HUSH_INSTALL_NATIVE_HELPER: compiled.path,
          [loginNativeHelperEnv]: compiled.loginPath,
        },
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Hush guarded installer terminated by ${result.signal}.`);
    process.exitCode = result.status ?? 1;
  } finally {
    compiled.cleanup();
  }
}

function installManagedRuntime(config, checkOnly) {
  validateToolchain(config);
  assertGuardedDescriptors();
  checkRoots(config);
  pauseForRaceTest("after-lock");
  cleanupStaleArtifacts(config, checkOnly);
  const source = readSourceIdentity();
  if (config.expectedCommit && source.tracked.commit !== config.expectedCommit) {
    throw new Error(
      `Hush source commit changed before staging: expected ${config.expectedCommit}, found ${source.tracked.commit}.`,
    );
  }
  const runtimeEntry = runtimeEntryInfo(config.runtimeParent, config.runtimeName);
  let stageName;
  let stageIdentity;
  let runtimeIdentity = runtimeEntry.identity;
  let primaryError;

  try {
    if (runtimeEntry.kind === "missing") {
      if (checkOnly) {
        throw new Error(
          `Hush runtime missing: ${config.runtimeRoot}. Re-run \`node scripts/install-local.mjs\`.`,
        );
      }
      stageName = `.hush-stage-${process.pid}-${randomBytes(8).toString("hex")}`;
      pauseForRaceTest("before-stage");
      stageIdentity = parseNativeIdentity(
        runNative(["stage", root, config.runtimeParent, stageName, ...stagedSourcePaths]),
        "stage",
      );
      runAtRuntime(config.runtimeParent, stageName, stageIdentity, process.execPath, [
        scriptPath,
        "--internal-staged-identity",
        encodeJson(source),
      ]);
      runAtRuntime(
        config.runtimeParent,
        stageName,
        stageIdentity,
        config.bunPath,
        [
          "install",
          "--production",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--backend",
          "copyfile",
          "--filter",
          "@chriscode/hush",
        ],
        false,
      );
      runAtRuntime(config.runtimeParent, stageName, stageIdentity, process.execPath, [
        scriptPath,
        "--internal-finalize-stage",
        encodeJson(source),
      ]);
      pauseForRaceTest("before-runtime-publish");
      assertSourceCommit(config, source.tracked.commit);
      runNative([
        "publish-runtime",
        config.runtimeParent,
        stageName,
        config.runtimeName,
        ...identityArgs(stageIdentity),
      ]);
      runtimeIdentity = stageIdentity;
      stageName = undefined;
    } else if (runtimeEntry.kind !== "directory") {
      throw new Error(`Hush runtime root must be a real directory: ${config.runtimeRoot}`);
    }
    validateRuntimeThroughGuard(config.runtimeParent, config.runtimeName, runtimeIdentity, source);
    checkRoots(config);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (stageName) {
      try {
        const currentStage = runtimeEntryInfo(config.runtimeParent, stageName);
        if (currentStage.kind === "directory") {
          const expected = stageIdentity ?? currentStage.identity;
          runNative(["remove-stale", config.runtimeParent, stageName, ...identityArgs(expected)]);
        } else if (currentStage.kind !== "missing") {
          throw new Error(`Hush stage changed before cleanup: ${stageName}`);
        }
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
  }

  const launcher = `#!/bin/sh
set -eu

unset NODE_PATH NODE_OPTIONS
exec ${shellQuote(realpathSync(process.execPath))} ${shellQuote(config.runtimeEntrypoint)} "$@"
`;

  if (checkOnly) {
    validateLauncher(config, launcher);
    const shadowed = ensureLoginShellDelivery(config, true);
    console.log(config.target);
    if (shadowed) process.exitCode = 1;
    return;
  }

  pauseForRaceTest("before-launcher-publish");
  assertSourceCommit(config, source.tracked.commit);
  checkRoots(config);
  const launcherTemporary = `.hush-launcher-${process.pid}-${randomBytes(8).toString("hex")}`;
  runNative(["write-launcher", config.binDir, launcherTemporary, "hush", "755"], {
    input: launcher,
  });
  validateLauncher(config, launcher);
  checkRoots(config);

  const activeName = config.runtimeName;
  if (/^[0-9a-f]{40}$/.test(activeName)) {
    const entries = listRuntimeEntries(config.runtimeParent);
    const unsafe = entries.find((entry) => entry.kind === "X");
    if (unsafe)
      throw new Error(`Hush managed runtime entry is symlinked or not a directory: ${unsafe.name}`);
    const candidates = entries
      .filter((entry) => entry.kind === "R" && entry.name !== activeName)
      .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
    for (const candidate of candidates.slice(1)) {
      pauseForRaceTest("before-prune");
      runNative([
        "prune-runtime",
        config.runtimeParent,
        candidate.name,
        ...identityArgs(candidate.identity),
      ]);
    }
  }

  if (ensureLoginShellDelivery(config, false)) process.exitCode = 1;
  console.log(config.target);
}

function internalSourceIdentity() {
  assertGuardedDescriptors();
  console.log(JSON.stringify(sourceIdentityFromInputs(".", ".")));
}

function internalStagedIdentity(encodedSource) {
  assertGuardedDescriptors();
  console.log(JSON.stringify(stagedSourceIdentity(".", decodeJson(encodedSource))));
}

function internalFinalizeStage(encodedSource) {
  assertGuardedDescriptors();
  const source = stagedSourceIdentity(".", decodeJson(encodedSource));
  const collected = validateRuntimeGraph(".", true);
  writeRuntimeManifest(".", source, collected.entries);
  validateRuntimeManifest(".", source, collected.entries);
}

function internalValidateRuntime(encodedSource) {
  assertGuardedDescriptors();
  validateManagedRuntime(".", decodeJson(encodedSource));
}

function main() {
  const args = process.argv.slice(2);
  assertInstallerPrerequisites();
  if (args[0] === "--internal-source-identity") return internalSourceIdentity();
  if (args[0] === "--internal-staged-identity") return internalStagedIdentity(args[1]);
  if (args[0] === "--internal-finalize-stage") return internalFinalizeStage(args[1]);
  if (args[0] === "--internal-validate-runtime") return internalValidateRuntime(args[1]);

  const guarded = args[0] === "--internal-guarded";
  const publicArgs = guarded ? args.slice(1) : args;
  const options = parsePublicOptions(publicArgs);
  if (options.sourceCheckout) {
    if (guarded) throw new Error("--source-checkout never runs under the managed install guard.");
    return runSourceCheckoutMode(options);
  }

  const config = resolveManagedConfig(guarded);
  if (!guarded) return runGuardedInstaller(config, publicArgs);
  return installManagedRuntime(config, options.checkOnly);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`hush: ${sanitizedDiagnostic(error.message, "installer failed")}`);
    process.exitCode = 1;
  }
}
