/**
 * `initOption()` and `initArg()`, written again in the type system.
 *
 * That is the cost of this file and there is no way around it: the only way to
 * know that `'--port <n>'` with `type: 'int'` produces a non-optional `port:
 * number` is to read the format string the way the parser reads it. So the rules
 * here move when those functions move, and `test/infer.test.ts` pins every pair
 * where the two could drift apart -- which is most of them.
 *
 * Nothing here exists at runtime. It is all erased, and the parser neither reads
 * nor is affected by any of it. Nothing here imports anything either: the rules
 * read the shape of a declaration rather than its declared type, so `types.ts` can
 * import this without a cycle.
 *
 * What this deliberately does not do is decide whether a schema is *valid*. A
 * variadic argument that is not last, `type: 'count'` on an option that takes a
 * value, and a format the parser rejects outright such as `'---triple'` are all
 * things it throws on, and the types describe them as though they had worked --
 * `'---triple'` even produces a key. Validity is the parser's to report, with a
 * message that says what to do; a type error here would say less and say it worse,
 * and the code never runs either way.
 */

// --------------------------------------------------------------- format strings

/** What separates the parts of a format string. */
type Delimiter = ' ' | ',' | '|' | '=';

/** What starts a hint, and therefore ends a name. */
type HintOpen = '<' | '[';

/** The characters up to the first delimiter or hint. */
type Word<S extends string, Acc extends string = ''> = S extends `${infer C}${infer Rest}`
	? C extends Delimiter | HintOpen | '>' | ']'
		? Acc
		: Word<Rest, `${Acc}${C}`>
	: Acc;

/**
 * The first part of a format string and what follows it, with leading delimiters
 * skipped. `undefined` once there is nothing left.
 *
 * The parts have to be walked in order rather than searched, because position is
 * what decides which one names the option: `initOption()` takes the first part
 * that is a long name or a bare word, so `'verbose, --all'` is named `verbose`
 * while `'--all, verbose'` is named `all`.
 */
type NextPart<S extends string, Acc extends string = ''> = S extends `${infer C}${infer Rest}`
	? C extends Delimiter
		? Acc extends ''
			? NextPart<Rest>
			: [Acc, Rest]
		: NextPart<Rest, `${Acc}${C}`>
	: Acc extends ''
		? undefined
		: [Acc, ''];

/** The first part that names the option: a long name, or a bare word. */
type NamingPart<S extends string> =
	NextPart<S> extends [infer Part extends string, infer Rest extends string]
		? Part extends `--${infer Long}`
			? Word<Long>
			: Part extends `-${string}`
				? NamingPart<Rest>
				: Part extends `${HintOpen}${string}`
					? NamingPart<Rest>
					: Word<Part>
		: never;

/** The first short name, which names the option only when nothing else did. */
type ShortPart<S extends string> =
	NextPart<S> extends [infer Part extends string, infer Rest extends string]
		? Part extends `--${string}`
			? ShortPart<Rest>
			: Part extends `-${infer Short}`
				? Word<Short>
				: ShortPart<Rest>
		: never;

type OptionName<S extends string> = [NamingPart<S>] extends [never] ? ShortPart<S> : NamingPart<S>;

/** Whether the format itself carries a hint, and which kind. */
type FormatHint<S extends string> = S extends `${string}<${string}>`
	? 'required'
	: S extends `${string}[${string}]`
		? 'optional'
		: 'none';

/**
 * Whether the option is a flag.
 *
 * A hint makes it valued, whether the format carried one or the declaration wrote
 * one out, and so does a `choices` array: `initOption()` gives an option with
 * choices an implied hint of `value`. That is the rule most easily missed, because
 * `'--mode': { choices: [...] }` looks like a flag and is not one.
 */
type IsFlag<K extends string, D> = D extends { hint: string }
	? false
	: FormatHint<FormatOf<K, D>> extends 'none'
		? D extends { choices: readonly unknown[] }
			? false
			: true
		: false;

/**
 * `no-color` gives `color`: a negated flag shares its twin's destination.
 *
 * Only a flag is negated, and only when `negate` was not turned off -- the same
 * pair of conditions `initOption()` applies, so `'--no-cheese [type]'` lands on
 * `noCheese` rather than on `cheese`.
 */
type Negated<K extends string, D> =
	IsFlag<K, D> extends true
		? D extends { negate: false }
			? NameOf<K, D>
			: NameOf<K, D> extends `no-${infer Rest}`
				? Rest
				: NameOf<K, D>
		: NameOf<K, D>;

/** What `camelCase()` splits on: `-`, `_`, and a space, in runs. */
type Separator = '-' | '_' | ' ';

type StripSeparators<S extends string> = S extends `${Separator}${infer Rest}`
	? StripSeparators<Rest>
	: S;

/** What `camelCase()` does, which is what the destination is named after. */
type CamelCase<S extends string> = S extends `${infer Head}${Separator}${infer Tail}`
	? `${Head}${CamelCase<Capitalize<StripSeparators<Tail>>>}`
	: S;

/**
 * The format string a declaration is read from.
 *
 * A declared `format` wins over the key it was written under, because that is what
 * `initCommand()` hands `initOption()`: the key only fills in for a missing one.
 */
type FormatOf<K extends string, D> = D extends { format: infer F extends string } ? F : K;

/**
 * The option's name. A declared `name` wins, because `initOption()` only fills one
 * in from the format when there is none.
 */
type NameOf<K extends string, D> = D extends { name: infer N extends string }
	? N
	: OptionName<FormatOf<K, D>>;

/** The key on `argv` that one declaration's value lands on. */
export type OptionDest<K extends string, D = unknown> = CamelCase<Negated<K, D>>;

// ------------------------------------------------------------------ data types

/** What each data type coerces to. `auto` and `json` are anything. */
type FromDataType<T> = T extends 'bool' | 'yesno'
	? boolean
	: T extends 'count' | 'int' | 'number'
		? number
		: T extends 'date'
			? Date
			: T extends 'json' | 'auto'
				? unknown
				: string;

/**
 * One option's value, before `multiple` collects it.
 *
 * `choices` comes first because it is the narrowest thing available: a declared
 * list of values is a literal union, which is more useful than the type those
 * values happen to have. An empty list gives `never`, which is what it means --
 * the parser rejects every value against it -- rather than something it would
 * accept. Then the declared type, and then the format, where a flag is a boolean
 * and anything valued is a string, since `string` rather than `auto` is this
 * library's default.
 */
type OptionValue<K extends string, D> = D extends { choices: readonly unknown[] }
	? D['choices'][number]
	: D extends { type: infer T }
		? FromDataType<T>
		: IsFlag<K, D> extends true
			? boolean
			: string;

/**
 * `multiple` collects repeated uses into an array -- except on a counter, which
 * counts them instead, so a counter is a `number`.
 *
 * Declaring both is refused by `initOption()`, and the answer here is still
 * `number`: validity is the parser's to report, and the types describe an invalid
 * declaration as though it had worked.
 */
type Collected<K extends string, D> = D extends { type: 'count' }
	? number
	: D extends { multiple: true }
		? OptionValue<K, D>[]
		: OptionValue<K, D>;

/** Whether a declaration has a default worth falling back to. */
type HasDefault<D> = D extends { default: infer V } ? (undefined extends V ? false : true) : false;

/**
 * Whether the declaration says the key is there whatever argv did.
 *
 * A default comes first, because one fills the destination whatever else was said
 * -- including `required: false`, which stops the parse from demanding the option
 * without stopping the fallback from filling it. `undefined` is not a default:
 * `applyFallback()` skips it, exactly as if none had been declared.
 *
 * Then `required` written out, in both directions, since writing it overrides the
 * `<>` that would otherwise have implied it.
 */
type Definite<K extends string, D> =
	HasDefault<D> extends true
		? true
		: D extends { required: true }
			? true
			: D extends { required: false }
				? false
				: FormatHint<FormatOf<K, D>> extends 'required'
					? true
					: false;

// ------------------------------------------------------------------- arguments

type ArgSpelling<A> = A extends string ? A : A extends { name: infer N } ? N : never;

/** `files...` gives `files`: the dots say variadic, they are not part of a name. */
type StripVariadic<S extends string> = S extends `${infer N}...` ? N : S;

type ArgName<S extends string> = StripVariadic<
	S extends `<${infer N}>${string}`
		? Word<N>
		: S extends `[${infer N}]${string}`
			? Word<N>
			: Word<S>
>;

/** Every spelling of variadic, and `multiple` written out. */
type ArgVariadic<S extends string, D> = S extends `${string}...${string}`
	? true
	: D extends { multiple: true }
		? true
		: false;

/** Only brackets decide it, or `required` written out. A bare name is optional. */
type ArgRequired<S extends string, D> = S extends `<${string}`
	? true
	: D extends { required: true }
		? true
		: false;

type ArgScalar<D> = D extends { choices: readonly unknown[] }
	? D['choices'][number]
	: D extends { type: infer T }
		? FromDataType<T>
		: string;

type ArgValue<S extends string, D> = ArgVariadic<S, D> extends true ? ArgScalar<D>[] : ArgScalar<D>;

// ---------------------------------------------------------------- the argv type

/**
 * Whether a declaration came through as the wide type rather than a literal one.
 *
 * Everything here reads literal types, and a declaration that was never narrowed
 * -- a command typed as `Command` with no parameters, one held as `AnyCommand`, or
 * one read off a module at runtime -- has nothing to read. Those get
 * `Record<string, unknown>`, which is what `argv` has always been.
 *
 * `any` is checked first and counts as wide. It arrives through `AnyCommand`, and
 * left alone it satisfies every pattern below at once: it matches the tuple walk,
 * which then recurses on `any` forever.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Whether a set of options is the wide type: one with an index signature, which is
 * what `Record<string, ...>` is and a literal declaration is not.
 *
 * `keyof` a literal is the format strings it declared; `keyof` the wide type is
 * `string`. Nothing narrower than `string` has `string` assignable to it, so this
 * is exact, and it answers correctly for `{}` too, whose `keyof` is `never`.
 */
type IsWideOptions<O> = IsAny<O> extends true ? true : string extends keyof O ? true : false;

/**
 * Whether a list is of unknown length, which is what an array type is and a tuple
 * is not. A tuple's `length` is a literal, and nothing but `number` has `number`
 * assignable to it.
 */
type IsWideList<A> =
	IsAny<A> extends true
		? true
		: A extends readonly unknown[]
			? number extends A['length']
				? true
				: false
			: true;

/** Every destination a set of options lands values on. */
type Dests<O> = { [K in keyof O]-?: OptionDest<K & string, O[K]> }[keyof O];

/**
 * Everything that lands on one destination, as a union.
 *
 * Two formats can share one: an option and its negated twin do by design, and the
 * destination then holds either of their values.
 */
type ValueFor<O, D> = {
	[K in keyof O]-?: OptionDest<K & string, O[K]> extends D ? Collected<K & string, O[K]> : never;
}[keyof O];

/** Whether anything landing on a destination says it is always there. */
type AnyDefinite<O, D> = true extends {
	[K in keyof O]-?: OptionDest<K & string, O[K]> extends D ? Definite<K & string, O[K]> : never;
}[keyof O]
	? true
	: false;

/** Whether everything landing on a destination is a flag. */
type AllFlags<O, D> = false extends {
	[K in keyof O]-?: OptionDest<K & string, O[K]> extends D ? IsFlag<K & string, O[K]> : never;
}[keyof O]
	? false
	: true;

/**
 * Whether a destination always holds something.
 *
 * Either the declaration said so, or everything landing there is a flag -- and a
 * flag always has a value, which is why `argv.verbose` needs no guard.
 *
 * "Everything" is what makes a dual option come out right. `'--cheese [type]'`
 * paired with `'--no-cheese'` is one destination carrying a flag and a valued
 * option, and the pair is `undefined` until something sets it: the negated flag's
 * implied default gives way to its valued twin, so the flag rule does not apply --
 * and nothing else claims it either.
 */
type AlwaysSet<O, D> =
	AnyDefinite<O, D> extends true ? true : AllFlags<O, D> extends true ? true : false;

type OptionsArgv<O> =
	IsWideOptions<O> extends true
		? Record<string, unknown>
		: {
				[D in Dests<O> as AlwaysSet<O, D> extends true ? D : never]: ValueFor<O, D>;
			} & {
				[D in Dests<O> as AlwaysSet<O, D> extends true ? never : D]?: ValueFor<O, D>;
			};

/**
 * Walked head by head rather than mapped over `keyof`, because `keyof` a tuple
 * carries `length`, `map`, and the rest of the array surface along with the
 * indices, and each of those would come out as a key of its own.
 *
 * An optional argument before a required one is promoted to required, since there
 * is no way to skip it -- so whether one is required depends on what comes after
 * it, which is why the tail is asked.
 */
type ArgsArgv<A> =
	IsWideList<A> extends true
		? Record<string, unknown>
		: A extends readonly [infer Head, ...infer Tail]
			? OneArg<Head, AnyArgRequired<Tail>> & ArgsArgv<Tail>
			: {};

type AnyArgRequired<A> = A extends readonly [infer Head, ...infer Tail]
	? ArgRequired<ArgSpelling<Head> & string, Head> extends true
		? true
		: AnyArgRequired<Tail>
	: false;

type OneArg<D, Promoted extends boolean> =
	ArgSpelling<D> extends infer S
		? S extends string
			? ArgAlways<S, D, Promoted> extends true
				? { [K in CamelCase<ArgName<S>>]: ArgValue<S, D> }
				: { [K in CamelCase<ArgName<S>>]?: ArgValue<S, D> }
			: {}
		: {};

/**
 * Whether an argument's key always holds something: it was required, something
 * after it was and it was promoted, or it has a default `processArgs()` fills in.
 */
type ArgAlways<S extends string, D, Promoted extends boolean> =
	ArgRequired<S, D> extends true ? true : HasDefault<D> extends true ? true : Promoted;

/**
 * Joins two sets of keys, merging rather than intersecting the ones they share.
 *
 * Intersecting is what an `&` does, and for a shared key it produces the
 * intersection of the two value types -- which for a `boolean` and a `string` is
 * `never`, a key nothing can be assigned to. Two sources can land on one
 * destination: an option and a positional argument of the same name both write to
 * it, and the value is whichever of them wrote last.
 *
 * A shared key holds the union, and is always there if either source always fills
 * it, because either filling it is enough.
 */
type Merge<A, B> = {
	[K in Extract<keyof A, AlwaysKeys<A>> | Extract<keyof B, AlwaysKeys<B>>]:
		| Lookup<A, K>
		| Lookup<B, K>;
} & {
	[K in Exclude<keyof A | keyof B, AlwaysKeys<A> | AlwaysKeys<B>>]?: Lookup<A, K> | Lookup<B, K>;
};

/** The keys of an object that are not optional. */
type AlwaysKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

/** One key's value, or nothing when the object does not have it. */
type Lookup<T, K> = K extends keyof T ? Exclude<T[K], undefined> : never;

/**
 * Collapses an intersection into one object, so that hovering `argv` shows the
 * keys rather than types joined by `&`.
 */
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/**
 * What `state.argv` holds for a command: its own options, its arguments, and
 * `unknown` for anything else.
 *
 * The index signature is the honest half of the answer. Options resolve across the
 * whole context chain, so `argv` also holds whatever the commands above this one
 * declared -- and inference cannot see them, because a command is typed at its own
 * `command()` call and nothing at that call knows where in the tree it will be
 * mounted. Saying nothing about those keys would make reading an ancestor's
 * `--verbose` an error about a value that is genuinely there, which is worse than
 * saying `unknown`.
 *
 * It is an intersection rather than a merge on purpose: a merge would spread the
 * index signature over the declared keys and make all of them `unknown` too. Here
 * what this command declared keeps its type and everything else is `unknown`.
 *
 * Either of the two parts being the wide type contributes `Record<string, unknown>`
 * of its own, which is the same answer for the same reason: nothing narrowed, so
 * nothing is known.
 */
export type InferArgv<O, A> = Flatten<Merge<OptionsArgv<O>, ArgsArgv<A>>> & Record<string, unknown>;
