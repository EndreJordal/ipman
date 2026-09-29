// Builds the release package that install.ps1 installs:
//
//   build/release/ipman.zip          app/: server.mjs (the whole server in one file), dist/ (the
//                                    frontend), version.json, install.ps1, ipman.ico
//   build/release/ipman.zip.sha256   its checksum, verified by the installer
//   build/release/install.ps1        the installer itself (for `irm …/install.ps1 | iex`)
//
// No node_modules at runtime: the frontend is bundled by Vite as always, and the server
// (including htmlparser2) is bundled into server.mjs. Run: npm run package
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build');
const app = path.join(out, 'app');
const release = path.join(out, 'release');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });

console.log(`Packaging ipman ${version}`);

// Frontend, with the normal Vite config.
await build({ root, logLevel: 'warn', build: { outDir: path.join(app, 'dist'), emptyOutDir: true } });

// Server: server/index.ts and everything it imports, as one ES module for Node.
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: path.join(root, 'server', 'index.ts'),
    outDir: app,
    emptyOutDir: false,
    target: 'node24',
    minify: false,
    rolldownOptions: { output: { entryFileNames: 'server.mjs' } },
  },
  ssr: { noExternal: true, target: 'node' },
});

writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');
copyFileSync(path.join(root, 'install.ps1'), path.join(app, 'install.ps1'));
copyFileSync(path.join(root, 'assets', 'ipman.ico'), path.join(app, 'ipman.ico'));

// ---------- Zip (deflate), without extra tools ----------

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function zip(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const name of listFiles(dir)) {
    const data = readFileSync(path.join(dir, name));
    const deflated = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const header = (signature, extra) => {
      const b = Buffer.alloc(signature === 0x04034b50 ? 30 : 46);
      b.writeUInt32LE(signature, 0);
      let o = 4;
      if (signature === 0x02014b50) b.writeUInt16LE(20, (o += 2) - 2); // made by
      for (const v of [20, 0x0800 /* UTF-8 names */, 8 /* deflate */, dosTime, dosDate]) b.writeUInt16LE(v, (o += 2) - 2);
      for (const v of [crc, deflated.length, data.length]) b.writeUInt32LE(v, (o += 4) - 4);
      b.writeUInt16LE(nameBytes.length, (o += 2) - 2);
      b.writeUInt16LE(0, (o += 2) - 2); // extra length
      if (extra) {
        for (const v of [0, 0, 0]) b.writeUInt16LE(v, (o += 2) - 2); // comment, disk, internal attrs
        b.writeUInt32LE(0, (o += 4) - 4); // external attrs
        b.writeUInt32LE(extra.offset, (o += 4) - 4);
      }
      return b;
    };
    const local = Buffer.concat([header(0x04034b50), nameBytes, deflated]);
    centrals.push(Buffer.concat([header(0x02014b50, { offset }), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

mkdirSync(release, { recursive: true });
const archive = zip(app);
writeFileSync(path.join(release, 'ipman.zip'), archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
writeFileSync(path.join(release, 'ipman.zip.sha256'), `${sha256}  ipman.zip\n`);
copyFileSync(path.join(root, 'install.ps1'), path.join(release, 'install.ps1'));

const files = listFiles(app);
console.log(`  ${files.length} files, server.mjs ${(statSync(path.join(app, 'server.mjs')).size / 1024).toFixed(0)} KB`);
console.log(`  build/release/ipman.zip  ${(archive.length / 1024).toFixed(0)} KB  sha256 ${sha256}`);
