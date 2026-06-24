import pc from 'picocolors';
import type { HushContext } from '../types.js';

export interface CompletionOptions {
  shell: string;
}

export const HUSH_COMMANDS = [
  'bootstrap',
  'bundle',
  'check',
  'completion',
  'config',
  'copy-key',
  'decrypt',
  'delete-key',
  'diff',
  'doctor',
  'edit',
  'encrypt',
  'expansions',
  'export-example',
  'file',
  'has',
  'init',
  'inspect',
  'keys',
  'list',
  'materialize',
  'migrate',
  'move-key',
  'push',
  'project',
  'resolve',
  'run',
  'set',
  'skill',
  'status',
  'target',
  'template',
  'trace',
  'verify-target',
] as const;

export const HUSH_FLAGS = [
  '--allow-plaintext',
  '--bundle',
  '--cleanup',
  '--config',
  '--dry-run',
  '--env',
  '--file',
  '--files',
  '--force',
  '--format',
  '--from',
  '--global',
  '--gui',
  '--help',
  '--json',
  '--keep-file',
  '--local',
  '--materialize-as',
  '--mode',
  '--new-repo',
  '--only-changed',
  '--output-root',
  '--quiet',
  '--ref',
  '--repo-local',
  '--require',
  '--require-source',
  '--reveal',
  '--root',
  '--skip-provider',
  '--skip-remote',
  '--subpath',
  '--surface',
  '--target',
  '--to',
  '--verbose',
  '--version',
  '--warn',
  '--yes',
  '-e',
  '-f',
  '-h',
  '-q',
  '-r',
  '-t',
  '-v',
  '-y',
] as const;

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

function isSupportedShell(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

function buildBashScript(): string {
  const commands = HUSH_COMMANDS.join(' ');
  const flags = HUSH_FLAGS.join(' ');
  return `# hush bash completion
# Install: hush completion bash >> ~/.bashrc
# Or:      hush completion bash > /etc/bash_completion.d/hush

_hush_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="${commands}"
  local flags="${flags}"

  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${commands} \${flags}" -- "\${cur}") )
    return
  fi

  case "\${prev}" in
    -e|--env)
      COMPREPLY=( \$(compgen -W "development production dev prod" -- "\${cur}") )
      return ;;
    -t|--target|--bundle|--from|--to)
      COMPREPLY=()
      return ;;
    --format)
      COMPREPLY=( \$(compgen -W "dotenv wrangler json shell yaml" -- "\${cur}") )
      return ;;
    --mode)
      COMPREPLY=( \$(compgen -W "process file example" -- "\${cur}") )
      return ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( \$(compgen -W "\${flags}" -- "\${cur}") )
    return
  fi

  COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
}

complete -F _hush_completion hush
`;
}

function buildZshScript(): string {
  const commandLines = HUSH_COMMANDS.map((cmd) => `    '${cmd}'`).join('\n');
  const flagLines = HUSH_FLAGS.map((flag) => `    '${flag}'`).join('\n');
  return `#compdef hush
# hush zsh completion
# Install: hush completion zsh > ~/.zsh/completions/_hush
# Or:      hush completion zsh > /usr/local/share/zsh/site-functions/_hush
# Make sure fpath includes your completions directory, then: autoload -Uz compinit && compinit

_hush() {
  local state

  _arguments -C \\
    '1: :->command' \\
    '*: :->args'

  local commands=(
${commandLines}
  )

  local flags=(
${flagLines}
  )

  case \$state in
    command)
      _describe 'hush commands' commands
      ;;
    args)
      case \$words[2] in
        bundle)
          _describe 'bundle subcommands' '("add:Add a new bundle" "add-file:Add a file to a bundle" "remove-file:Remove a file from a bundle" "remove:Remove a bundle" "list:List bundles")'
          ;;
        config)
          _describe 'config subcommands' '("show:Show v3 structure" "active-identity:Show or set active identity" "readers:Update file readers")'
          ;;
        file)
          _describe 'file subcommands' '("add:Add an encrypted file" "remove:Remove an encrypted file" "list:List encrypted files" "readers:Update file readers")'
          ;;
        keys)
          _describe 'keys subcommands' '("setup:Verify local age key" "generate:Generate new local age key" "list:List age keys")'
          ;;
        target)
          _describe 'target subcommands' '("add:Add a target" "remove:Remove a target" "list:List targets")'
          ;;
        project)
          _describe 'project subcommands' '("plan:Report contract drift" "validate:Fail on remaining drift" "sync:Push runtime worker secrets")'
          ;;
        *)
          _describe 'hush options' flags
          ;;
      esac
      ;;
  esac
}

_hush
`;
}

function buildFishScript(): string {
  const commandCompletions = HUSH_COMMANDS.map(
    (cmd) => `complete -c hush -f -n '__fish_use_subcommand' -a '${cmd}'`,
  ).join('\n');
  const flagCompletions = HUSH_FLAGS.map(
    (flag) => `complete -c hush -n 'not __fish_use_subcommand' -l '${flag.replace(/^-+/, '')}'`,
  ).join('\n');

  return `# hush fish completion
# Install: hush completion fish > ~/.config/fish/completions/hush.fish

function __fish_use_subcommand
  set -l cmd (commandline -opc)
  for i in (seq 2 (count \$cmd))
    if not string match -q -- '-*' \$cmd[\$i]
      return 0
    end
  end
  return 1
end

# Commands
${commandCompletions}

# Flags
complete -c hush -l 'env' -r -d 'Environment: development or production'
complete -c hush -l 'root' -r -d 'Start directory'
complete -c hush -l 'target' -r -d 'Target name'
complete -c hush -l 'bundle' -r -d 'Bundle name'
complete -c hush -l 'from' -r -d 'Source file or version'
complete -c hush -l 'to' -r -d 'Destination file or directory'
complete -c hush -l 'output-root' -r -d 'Output root directory'
complete -c hush -l 'ref' -r -d 'Git ref'
complete -c hush -l 'require' -r -d 'Required key'
complete -c hush -l 'format' -r -d 'Output format'
complete -c hush -l 'mode' -r -d 'Materialization mode'
complete -c hush -l 'file' -r -d 'Set destination file'
complete -c hush -l 'files' -r -d 'File list (csv)'
complete -c hush -l 'json' -d 'Machine-readable JSON output'
complete -c hush -l 'dry-run' -d 'Preview changes without applying'
complete -c hush -l 'verbose' -d 'Verbose output'
complete -c hush -l 'quiet' -d 'Suppress output'
complete -c hush -l 'warn' -d 'Warn but exit 0'
complete -c hush -l 'global' -d 'Use global store'
complete -c hush -l 'local' -d 'Use local scope'
complete -c hush -l 'force' -d 'Force operation'
complete -c hush -l 'yes' -d 'Skip confirmation'
complete -c hush -l 'gui' -d 'Use GUI dialog for input'
complete -c hush -l 'reveal' -d 'Print plaintext values'
complete -c hush -l 'repo-local' -d 'Write to repo-local overrides'
complete -c hush -l 'new-repo' -d 'Force child-local bootstrap'
complete -c hush -l 'cleanup' -d 'Remove validated leftovers'
complete -c hush -l 'keep-file' -d 'Keep file on remove'
complete -c hush -l 'only-changed' -d 'Only check modified files'
complete -c hush -l 'require-source' -d 'Fail if source is missing'
complete -c hush -l 'allow-plaintext' -d 'Allow plaintext files'
complete -c hush -l 'help' -d 'Show help'
complete -c hush -l 'version' -d 'Show version'

# Env value completions
complete -c hush -l 'env' -r -a 'development production dev prod' -d 'Environment'
complete -c hush -l 'format' -r -a 'dotenv wrangler json shell yaml' -d 'Output format'
complete -c hush -l 'mode' -r -a 'process file example' -d 'Materialization mode'
`;
}

export async function completionCommand(ctx: HushContext, options: CompletionOptions): Promise<void> {
  const { shell } = options;

  if (!shell || !isSupportedShell(shell)) {
    ctx.logger.error(pc.red(`Unknown shell: ${shell || '(none provided)'}`));
    ctx.logger.error(pc.dim(`Supported shells: ${SUPPORTED_SHELLS.join(', ')}`));
    ctx.logger.error(pc.dim('Usage: hush completion <bash|zsh|fish>'));
    ctx.process.exit(1);
    return;
  }

  switch (shell) {
    case 'bash':
      ctx.logger.log(buildBashScript());
      break;
    case 'zsh':
      ctx.logger.log(buildZshScript());
      break;
    case 'fish':
      ctx.logger.log(buildFishScript());
      break;
  }
}
