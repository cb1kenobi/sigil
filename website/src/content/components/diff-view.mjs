import { runApp } from '@ttylabs/sigil/app';
import { DiffView } from '@ttylabs/sigil/components/diff-view';

const patch = `diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,4 +1,4 @@
 export function retry(run) {
-  const attempts = 3;
+  const attempts = 5;
   for (let i = 0; i < attempts; i++) {
     try {
@@ -12,3 +12,3 @@
   }
-  throw new Error('gave up');
+  throw new Error(\`gave up after \${attempts} tries\`);
 }
`;

const app = runApp(() => DiffView({ content: { patch }, props: { 'flex-grow': 1 } }));

process.exitCode = await app.exited;
