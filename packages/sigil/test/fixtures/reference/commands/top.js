/**
 * A routed command whose options exist only here.
 *
 * Which is the whole reason a reference imports every module: `sigil build`
 * lifts `desc` and `hidden` and nothing lifts an option, so a surface that
 * names `--loud` is a surface that read this file.
 *
 * `.js` rather than `.ts`, which is what the completion fixtures beside it are
 * and for a reason worth copying: `packages/sigil`'s `include` covers `./test`,
 * so a `.ts` fixture is compiled under `--isolatedDeclarations` and a
 * declaration written the way an app writes one does not satisfy it.
 */
export default {
  desc: 'A top-level command',
  options: { '--loud': { type: 'bool' } },
  run: () => undefined,
};
