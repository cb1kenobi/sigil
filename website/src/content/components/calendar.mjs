import { calendar } from '@ttylabs/sigil/components/calendar';

console.log(
  calendar({
    selected: new Date(2026, 10, 12),
    highlight: [new Date(2026, 10, 3), new Date(2026, 10, 20)],
  })
);
