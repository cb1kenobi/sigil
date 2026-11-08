# `packages/sigil/src/png` — deliberate decisions

These are the decisions about this directory. Claude Code loads this file when
it works with files here; other agents should read it before changing anything
in this area. The root [`AGENTS.md`](../../../../AGENTS.md) holds the rules that
apply everywhere and still applies in full.

## Deliberate decisions — do not "fix" these

### A PNG codec, both directions, with nothing beyond `node:zlib`

`@ttylabs/sigil/png` is `decodePng()`, `encodePng()` and the one shape both use,
`RgbaImage`: 8-bit RGBA, row-major, straight alpha, `data.length === width *
height * 4`. Decoding is what lets an image be drawn at all; encoding is what a
screenshot writes. SIG-114.

- **It does not reopen the image-protocol decision.** `src/canvas/AGENTS.md`
  refuses Kitty, iTerm2 and Sixel, and that stands: nothing here draws an image
  any better. It makes it possible to get pixels in and out.

- **PNG and not JPEG, because `node:zlib` is the whole of the hard part.**
  `inflateSync()`, `deflateSync()` and `crc32()` are core on the `engines` floor,
  and what is left is well specified and has PngSuite to test against. A
  baseline DCT decoder is not worth writing to satisfy the dependency rule.
  Raw RGBA is the way in for every other format, so a caller with a JPEG brings
  a decoder and hands this the pixels.

- **The API is synchronous.** A screenshot is written in a `finally` and an
  image is decoded on the way to a frame, and neither wants an `await` in the
  middle; the sync zlib calls are what make the codec a pure function of its
  bytes.

- **zlib is asked for when the codec runs, not imported (SIG-328).** Every zlib
  call is inside a function, and the codec is on the components entry because
  `imageView()` decodes bytes, so a static `import` made every app that imported
  any component load zlib -- about 0.6 ms of a fresh node's import, for apps
  that never draw a picture. `zlib()` in `zlib.ts` is
  `process.getBuiltinModule('node:zlib')`, which is synchronous, so the API is
  as it was; the first decode or encode pays the load instead. The deflate
  options are built in `deflate()` rather than held at module level, because an
  object reading `constants` at load is zlib at load by another route -- and
  `sigil build` kept exactly that member read in an app that drew one spinner,
  since a tree-shaker cannot prove it pure. Pinned statically and at run time in
  `test/dist.test.ts`, and for a built app in
  `packages/cli/test/build/shake-builtins.test.ts`; the audit is in
  `src/testing/AGENTS.md`.

- **The contract was fixed before the code, because two other packages were
  written against it at the same time.** Three names and one shape. What has
  been added is a trailing options bag on `decodePng()` and `MAX_PIXELS`, which
  is all the contract allowed.

#### Decoding

- **Output is always 8-bit RGBA, and a 16-bit sample is _rounded_, not
  truncated.** `(v + 128) / 257` floored is `round(v / 257)` without a float, and
  since 257 is odd there is never a tie. Taking the high byte -- libpng's
  `png_set_strip_16()`, and what several decoders do -- reads `0xff00` as 255
  where it is nearest 254. Rounding is also what ImageMagick does, which matters
  because ImageMagick is the oracle the corpus is checked against.
  `should round a 16-bit sample to the nearest 8-bit one rather than truncating
  it` pins a value on each side.

- **A 16-bit `tRNS` key is compared before the reduction.** `0x1234` and
  `0x1235` both round to 18, and only the one the chunk names is transparent.
  Comparing after would make two pixels clear where the file said one.

- **Gamma, chromaticity, `sRGB`, `iCCP` and `sBIT` are skipped, so the samples
  come back as stored.** Colour management is not something a terminal can act
  on, and applying a gAMA would make a round trip through the encoder -- which
  writes none -- change the pixels. ImageMagick's `rgba:` output agrees, which
  is what lets all 162 references match.

- **Every CRC is checked, an ancillary chunk's as much as a critical one's.**
  libpng warns and discards on a bad ancillary CRC; this throws. A file whose
  bytes have been damaged anywhere is not a file whose pixels can be trusted
  everywhere else, and "never returns part of an image" is easier to promise
  without a category of damage that is waved through.

- **What a decoder may be lenient about, this one is not, with one exception.**
  A critical chunk it does not know is refused (the specification's own rule).
  So is a `PLTE` in a greyscale image, a `tRNS` on a type that already has
  alpha, a palette index past the end of the palette, image data short _or_
  long of what IHDR implies, and IDAT chunks with something between them. The
  exception is bytes after `IEND`, which are ignored: nothing can be read from
  them, and refusing would fail files that only had something appended. A
  `PLTE` in a truecolour image is a suggested palette for a display that cannot
  show truecolour, and is ignored rather than refused, because the
  specification allows it -- `pp0n2c16.png` and `pp0n6a08.png` carry one. One
  of them, though: whether a `PLTE` has been seen is tracked apart from the
  palette the decoder keeps, which stays `undefined` for a truecolour image, so
  a second one is refused there as it is for an indexed image.

- **Inflation is bounded by IHDR, and `maxPixels` bounds IHDR.** The image data
  inflates to exactly `sum(rows * (stride + 1))` over the passes, and that
  figure is `inflateSync()`'s `maxOutputLength`, so a deflate bomb stops at the
  size of the image. Measured: 64 MiB of zeros in a 1x1 image is refused in
  well under the test's one-second bound. But IHDR is attacker-controlled too,
  and a 65536 by 65536 header asks for 16 GiB of RGBA in 33 bytes -- so
  `maxPixels`, default 2^28 (a 16384-square image, 1 GiB of RGBA), is checked
  against IHDR before anything is inflated or allocated. A default rather than
  `Infinity`, because the caller most likely to need it is the one decoding a
  file somebody else supplied, and that caller is the least likely to know to
  ask. Raise it per call, or pass `Infinity` to lift it on purpose. `null` and
  `undefined` mean the default, as an omitted option does. Anything else that
  is not a number, and `NaN` or a negative, is a `TypeError` rather than
  coerced, because the check is a comparison and `n > NaN` is false: a `NaN`
  cap read from an unset config value used to lift the cap rather than fail,
  which review round 1 found.

- **A chunk type that is not four letters is named in hex.** The type is four
  bytes of the file, and the error is printed to a terminal: a type of
  `ESC [ 2 J` would clear the screen of whoever read the message. The check for
  letters is the specification's own, so it costs nothing to be strict about.
  The encoder's `TypeError`s escape a control character in whatever they quote
  of their argument for the same reason -- a string width, or a
  `Symbol.toStringTag` -- even though the caller wrote it, because a CLI's error
  handler still prints it.

- **The decoder's errors are translated with `__`, and the encoder's are not.**
  A malformed PNG is very often a file the user supplied, so its error reaches
  them through `errorHandler()`'s translated `Error: {0}` frame, and the JSONC
  reader's parse errors are the precedent: they describe a user's file and they
  are translated. The encoder's `TypeError`s describe a programming mistake,
  which is the category `src/i18n/AGENTS.md` records SIG-53 leaving in English.
  That is 32 keys, regenerated into `src/i18n/keys.ts`. A zlib message inside
  one is left as zlib wrote it, since it is a value in a slot.

#### Encoding

- **Indexed at 256 colours or fewer, counting a colour as all four channels.**
  The smallest depth that holds the palette -- 1, 2, 4 or 8 -- and a `tRNS`
  chunk when any entry has alpha. Otherwise RGB, or RGBA when any pixel's alpha
  is below 255. Measured on a synthetic 960x640 screenshot: indexed was
  **41% smaller** than truecolour over the same pixels.

- **Lossless, so a fully transparent pixel keeps its colour.** Folding every
  `alpha === 0` pixel onto one colour would free palette slots and is what an
  optimizer does; it also makes `decodePng(encodePng(x))` differ from `x`, which
  is the property the round-trip tests and a committed screenshot both rely on.

- **The palette is translucent entries first, each half in first-appearance
  order.** Translucent first because `tRNS` may stop at the last translucent
  entry and opaque ones after it need no byte. First appearance because it is a
  function of the pixels alone, which is the determinism rule.

- **A truecolour row gets the minimum-sum-of-absolute-differences filter, and a
  palette image is deflated both filtered and unfiltered.** The specification
  says no filter for a palette, because an index is a name rather than a
  quantity, and measurement agreed for a screenshot: the heuristic was **33%
  larger** (103,093 B against 77,733 B). It disagreed for PngSuite, whose
  greyscale gradients fit in 256 colours and whose palette, in first-appearance
  order, is the gradient again -- the whole corpus re-encoded to 87,416 B
  unfiltered against 78,310 B filtered, and 77,077 B keeping the smaller per
  image. Neither rule is right for both, so both are compressed and the smaller
  is kept, ties going to unfiltered. It costs a second deflate for an indexed
  image; that screenshot encodes in about 23 ms with both. Ties
  between filters go to the lower type, so the choice is a function of the bytes.

- **Level 6, and every deflate setting spelled out.** Level 9 was measured at
  **3x slower** for **0.8%** fewer bytes on the indexed screenshot, 1.7% on its
  truecolour twin and 1.4% over PngSuite. Spelled out -- level, `memLevel`,
  strategy, window -- so that a default changing in node does not move the
  bytes.

- **Deterministic: no clock, no locale, no ancillary chunk.** The same pixels
  give the same bytes, so a screenshot can be committed and diffed. That depends
  on zlib's output too, which this repository does not control: node ships
  Chromium's zlib, and node 24.18 (zlib 1.3.1), 26.8 and 26.10 (1.3.2.1-motley)
  were measured giving identical deflate output on arm64 macOS. `should write
  the same bytes on every platform CI runs on` pins two images by SHA-256 and is
  how the other eight CI combinations are asked -- and all nine (node 22, 24
  and 26 on macOS, Ubuntu and Windows) gave those bytes on the PR that added
  it. If one ever disagrees, the determinism claim is per platform and has to
  be written down as such rather than the hash updated.

- **No greyscale output, by the ticket's own list.** A greyscale image with 256
  or fewer distinct values is a palette anyway, and an 8-bit grey image cannot
  have more; only grey-with-alpha could, and that is RGBA here. Worth revisiting
  only with a measurement that says it is worth a fourth path.

- **A `Uint8ClampedArray` is accepted as well as a `Uint8Array`.** It is what a
  canvas hands back and it is the same bytes; any other typed array is refused,
  because `Float32Array` of the right length is not RGBA.

#### One check of the shape

- **`assertRgbaImage()` is the encoder's check, published, and the image
  component uses it too (SIG-326).** SIG-326 wrote its own check of the same
  shape for `resampleImage()` beside this one, and two checks of one shape are
  two answers to what a picture is. The encoder's was the stricter and the more
  careful, so it is the one that stayed: `encodePng()` calls it with
  `{ name: 'encodePng()', min: 1 }` and its four messages are word for word
  what they were, which `should keep the encoder's messages, word for word`
  pins. What `name` buys is that `resampleImage()` and `imageView()` say the
  same thing in their own words.
- **What changed was the other check, in three ways, and the encoder in none.**
  The image side accepted any safe integer and now stops at 2^31-1, IHDR's
  limit -- no limit in practice, since a picture that wide is eight gigabytes of
  `data`. It threw JavaScript's own `TypeError` on a `null` or `undefined`
  picture and now throws this one. And its messages are this one's. The single
  difference kept is the minimum: an empty picture is a picture -- a component
  draws nothing for one -- while a PNG cannot be empty, so `min` defaults to 0
  and the encoder asks for 1.
- **It lives in `image.ts` beside the type, and so does the 2^31-1.**
  `resampleImage()` imports it from that module rather than from the subpath's
  barrel, because the barrel is the codec: checking a shape must not put about
  10 kB of codec into `@ttylabs/sigil/canvas`. It was written when `chunks.ts`
  imported `node:zlib` for its CRC, which made zlib the louder half of the
  reason; since SIG-328 the codec asks for zlib only when it runs, and the bytes
  are reason enough. So the constant moved here too and `MAX_CHUNK_LENGTH` reads
  it, which is one definition of one number. `should keep zlib out of the
  canvas` in `test/dist.test.ts` fails if the import goes through the barrel.

#### The corpus

- **PngSuite is vendored whole, and checked against ImageMagick rather than
  against our own encoder.** `test/png/fixtures/pngsuite/` is the 2017-07-19
  release, freely redistributable under the licence beside it. A round trip
  proves the two halves agree with each other, and two halves written by one
  author can agree on one mistake, so `reference.json` holds what ImageMagick
  decodes each valid file to -- width, height, and a SHA-256 of the RGBA -- and
  `scripts/generate-png-reference.mjs` is how it was made. The test reads the
  JSON and needs nothing installed. All 162 matched on the first run, which is
  recorded because it is the evidence the decoder is right rather than merely
  self-consistent. The 14 `x*` files each throw a readable `Error`, and every
  valid file also round-trips through the encoder.

- **The corpus is allowed as a directory in `test/sources.test.ts`, not file by
  file.** 176 images would bury the nineteen names in `ALLOWED`, each of which is
  a decision about one file. What keeps it from being a hole is that only
  `.png` files under it are skipped, and a test asserts the suite's README and
  licence are still read as text. The README keeps its tabs: it is somebody
  else's file, vendored as it was published apart from its line endings.

- **The published subpath is tested from `packages/cli`.** The runtime's own
  tests reach `src/` through vite; `packages/cli/test/png-subpath.test.ts`
  imports `@ttylabs/sigil/png` by name, which is where a test that needs `dist/`
  belongs, and the bundle is where the control-character escape pass runs over
  a module whose signature constant is three control bytes.
