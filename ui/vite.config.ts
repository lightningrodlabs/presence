import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import checker from 'vite-plugin-checker';
import { viteStaticCopy } from 'vite-plugin-static-copy'

/**
 * `@theweave/api` may be a `file:` link into a sibling moss checkout while
 * the localModels API is unreleased. Vite refuses to serve linked sources
 * from outside the workspace unless they are allowed explicitly, so the
 * linked package's repo root (its own node_modules included) is added.
 */
function linkedApiRepoRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // <repo>/libs/api/dist/index.js -> <repo>
    const entry = realpathSync(require.resolve('@theweave/api'));
    return path.resolve(path.dirname(entry), '..', '..', '..');
  } catch {
    return undefined;
  }
}
const apiRoot = linkedApiRepoRoot();

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      // ...
    },
  },
  plugins: [
    checker({
      typescript: true,
      // eslint: {
      //   lintCommand: 'eslint --ext .ts,.html . --ignore-path .gitignore',
      // },
    }),
    viteStaticCopy({
      targets: [
        {
          src: "icon.png",
          dest: ".",
        },
        {
          src: "public",
          dest: "."
        }
      ]
    })
  ],
  define: {
    '__APP_VERSION__': JSON.stringify(process.env.npm_package_version),
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), ...(apiRoot ? [apiRoot] : [])],
    },
  },
});
