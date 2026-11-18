import { runApp } from '@ttylabs/sigil/app';
import { palette, rgb } from '@ttylabs/sigil/canvas';
import { Treemap } from '@ttylabs/sigil/components/treemap';

// a bundle by module, in kilobytes: the app's own code and what it depends on
const bundle = {
  name: 'dist',
  children: [
    {
      name: 'node_modules',
      children: [
        { name: 'react-dom', size: 132 },
        { name: 'lodash', size: 71 },
        { name: 'date-fns', size: 38 },
        { name: 'zod', size: 24 },
        { name: 'clsx', size: 1 },
      ],
    },
    {
      name: 'src',
      children: [
        { name: 'editor', size: 46 },
        { name: 'charts', size: 31 },
        { name: 'app', size: 12 },
        { name: 'routes', size: 9 },
      ],
    },
    { name: 'assets', size: 22 },
  ],
};

const total = (node) => node.size ?? node.children.reduce((sum, child) => sum + total(child), 0);
const theirs = new Set(bundle.children[0].children);

const app = runApp(() =>
  Treemap({
    root: bundle,
    size: total,
    children: (node) => node.children,
    key: (node) => node.name,
    label: (node) => `${node.name} ${total(node)}k`,
    // what it depends on in magenta, its own code in blue; the sixteen's own
    // hues at 16 colours, and degraded from the RGB above that
    color: (node, level) => {
      if (theirs.has(node)) {
        return level === 1 ? palette(5) : rgb(190, 96, 200);
      }
      return level === 1 ? palette(4) : rgb(78, 128, 226);
    },
    current: 'editor',
    props: { 'flex-grow': 1 },
  })
);

process.exitCode = await app.exited;
