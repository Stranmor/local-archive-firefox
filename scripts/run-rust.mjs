import { accessSync, constants, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] || '';
const actionArgs = process.argv.slice(3);
const toolchain = process.env.RUSTUP_TOOLCHAIN || readToolchainChannel();

function readToolchainChannel() {
  const source = readFileSync(path.join(projectRoot, 'rust-toolchain.toml'), 'utf8');
  return source.match(/^channel\s*=\s*["']([^"']+)["']/mu)?.[1] || 'stable';
}

function pathIsRunnable(candidate) {
  try {
    const resolved = realpathSync(candidate);
    // A rustup shim can answer `--version` successfully while the actual
    // pinned toolchain lives on a noexec mount. Treat the shim as a resolver,
    // not as a runnable compiler tool, so we never report a false green check.
    if (path.basename(resolved) === 'rustup') return false;
    accessSync(candidate, constants.X_OK);
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function executableFromPath(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    if (pathIsRunnable(candidate)) return candidate;
  }
  return null;
}

function commandFromPath(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function mirrorDirectories() {
  const temporaryRoots = [path.join(os.tmpdir(), 'local-archive-rust-exec-toolchains'), path.join(os.tmpdir(), 'rust-exec-toolchains')];
  try {
    for (const entry of readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('-rust-exec-toolchains')) {
        temporaryRoots.push(path.join(os.tmpdir(), entry.name));
      }
    }
  } catch {
    // The explicit environment root and the standard names remain sufficient.
  }
  const roots = [...new Set([process.env.RUST_EXEC_TOOLCHAINS_ROOT, ...temporaryRoots].filter(Boolean))];
  const directories = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === toolchain || entry.name.startsWith(`${toolchain}-`)) {
        directories.push(path.join(root, entry.name, 'bin'));
      }
    }
  }
  return directories;
}

function executable(name, { mirrorFirst = true } = {}) {
  const directories = mirrorFirst ? mirrorDirectories() : [];
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (pathIsRunnable(candidate)) return candidate;
  }
  const rustup = commandFromPath('rustup');
  if (rustup) {
    const resolved = spawnSync(rustup, ['which', name, '--toolchain', toolchain], { encoding: 'utf8' });
    const candidate = resolved.status === 0 ? resolved.stdout.trim() : '';
    if (candidate && pathIsRunnable(candidate)) return candidate;
  }
  const fromPath = executableFromPath(name);
  if (fromPath) return fromPath;
  throw new Error(`Could not find a runnable ${name} for Rust toolchain ${toolchain}.`);
}

function environmentFor(executable) {
  const directory = path.dirname(executable);
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return {
    ...process.env,
    RUSTUP_TOOLCHAIN: toolchain,
    PATH: [directory, ...pathEntries.filter((entry) => entry !== directory)].join(path.delimiter),
  };
}

function invoke(executable, args) {
  return spawnSync(executable, args, {
    cwd: projectRoot,
    env: environmentFor(executable),
    stdio: 'inherit',
  });
}

function run(executable, args) {
  const result = invoke(executable, args);
  if (result.error) throw result.error;
  if (typeof result.status === 'number') process.exit(result.status);
  process.exit(1);
}

function rustFiles() {
  const result = spawnSync('find', [path.join(projectRoot, 'crates'), '-name', '*.rs', '-print0'], {
    encoding: 'buffer',
  });
  if (result.status !== 0) throw new Error('Could not enumerate Rust source files.');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function runDirectRustfmt(check) {
  const rustfmt = executable('rustfmt');
  const args = ['--edition', '2024', ...(check ? ['--check'] : []), ...rustFiles()];
  run(rustfmt, args);
}

if (action === 'fmt' || action === 'fmt:check') {
  const check = action === 'fmt:check' || actionArgs.includes('--check');
  try {
    // Invoke the pinned cargo-fmt binary directly. `cargo fmt` can resolve
    // through a rustup shim on noexec mounts and report a misleading success
    // after failing to execute cargo-fmt.
    const cargoFmt = executable('cargo-fmt');
    const result = invoke(cargoFmt, ['--all', ...(check ? ['--', '--check'] : [])]);
    if (!result.error && result.status === 0) process.exit(0);
  } catch {
    // A noexec rustup mount can expose cargo but not cargo-fmt. The direct
    // rustfmt route preserves the same edition and checks every workspace crate.
  }
  runDirectRustfmt(check);
}

if (action === 'clippy') {
  const cargo = executable('cargo');
  run(cargo, ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
}

if (action === 'test') {
  const cargo = executable('cargo');
  run(cargo, ['test', '--workspace', '--all-targets']);
}

if (action === 'wasm-build') {
  const wasmPack = executable('wasm-pack', { mirrorFirst: false });
  run(wasmPack, [
    'build',
    'crates/local-archive-core',
    '--target', 'bundler',
    '--release',
    '--out-dir', '../../src/generated/local-archive-core',
    '--out-name', 'local_archive_core',
  ]);
}

throw new Error(`Unknown Rust runner action: ${action}`);
