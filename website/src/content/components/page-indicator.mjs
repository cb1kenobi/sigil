import { createPaginator } from '@ttylabs/sigil/components/paginator';

const results = Array.from({ length: 23 }, (_, i) => `result-${i + 1}.log`);
const pages = createPaginator({ perPage: 5, total: results.length });

pages.next();
console.log(pages.slice(results).join('  '));
console.log(pages.indicator({ style: 'both' }));
