'use client';

import { capture, type PackageManager } from '@/lib/analytics';
import { copyText } from '@/lib/clipboard';
import {
  COMMANDS,
  PACKAGE_MANAGERS,
  nextTabIndex,
  type InstallPackage,
} from '@/lib/install-command';
import { packageManagerStore } from '@/lib/package-manager-store';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

export interface InstallCommandProps {
  /** What it installs: the framework as a dependency, or the CLI run once. */
  package: InstallPackage;
  /**
   * `box` is the hero's own box, with a tab row above the command. `title-bar`
   * puts the tabs and Copy in a terminal block's title bar, for the docs.
   */
  variant?: 'box' | 'title-bar';
  /** Where it is on the page, sent with the analytics events: `home-hero`, `getting-started`. */
  location: string;
}

/**
 * The install command, with vlt, pnpm and npm tabs.
 *
 * Every box on a page shares one selection (`packageManagerStore`), which is
 * remembered in `localStorage`. The server renders npm, and a stored choice
 * applies after hydration: `useSyncExternalStore` renders the server snapshot
 * first on the client too, so hydration matches, and then re-renders.
 *
 * Nothing moves when it does. The command row has a fixed height, and in the
 * box all three commands are laid in one grid cell with the unselected two
 * hidden, so the box is as wide as the longest and a switch never resizes it.
 */
export function InstallCommand({ package: pkg, variant = 'box', location }: InstallCommandProps) {
  const manager = useSyncExternalStore(
    packageManagerStore.subscribe,
    packageManagerStore.getSnapshot,
    packageManagerStore.getServerSnapshot
  );
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const commands = COMMANDS[pkg];
  const command = commands[manager];
  const titleBar = variant === 'title-bar';

  function select(next: PackageManager) {
    if (next === manager) {
      return;
    }
    packageManagerStore.select(next);
    capture('package_manager_selected', { manager: next, location });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = nextTabIndex(index, event.key, PACKAGE_MANAGERS.length);
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    select(PACKAGE_MANAGERS[target]);
    tabRefs.current[target]?.focus();
  }

  const tabs = (
    <div
      role="tablist"
      aria-label="Package manager"
      className={titleBar ? 'flex gap-0.5' : 'flex gap-0.5 border-b border-line-term px-2'}
    >
      {PACKAGE_MANAGERS.map((name, index) => {
        const selected = name === manager;
        return (
          <button
            key={name}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-selected={selected}
            aria-controls={`${id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => select(name)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`cursor-pointer px-3 font-mono text-[12px] focus-visible:outline-offset-[-2px] ${
              titleBar ? 'h-10' : 'h-[34px]'
            } ${
              selected
                ? 'text-fg-strong shadow-[inset_0_-2px_0_var(--color-link)]'
                : 'text-muted hover:text-fg-body'
            }`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );

  const copy = (
    <CopyButton
      command={command}
      manager={manager}
      package={pkg}
      location={location}
      className={titleBar ? 'h-[30px] rounded-btn-sm px-2.5' : 'h-[38px] rounded-segment px-3'}
    />
  );

  if (titleBar) {
    return (
      <div className="overflow-hidden rounded-panel border border-line-panel bg-terminal">
        <div className="flex items-center border-b border-line-term pr-2 pl-2.5">
          {tabs}
          <span className="grow" />
          {copy}
        </div>
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${manager}`}
          className="flex gap-[1ch] overflow-x-auto px-5 pt-4 pb-[18px] font-mono text-term whitespace-pre text-fg-term"
        >
          <span aria-hidden="true" className="text-term-accent">
            $
          </span>
          <span>{command}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-full min-w-0 flex-col rounded-control border border-line-input bg-terminal">
      {tabs}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${manager}`}
        className="flex h-[50px] min-w-0 items-center gap-3.5 pr-1.5 pl-[18px] font-mono text-[15px] text-fg"
      >
        <span aria-hidden="true" className="text-term-accent">
          $
        </span>
        {/*
         * One grid cell, three commands. The two not shown keep their width and
         * nothing else: `invisible` and `aria-hidden`, so they are neither seen
         * nor read, and the cell is as wide as the longest.
         */}
        <span className="grid min-w-0 grow">
          {PACKAGE_MANAGERS.map((name) => (
            <span
              key={name}
              aria-hidden={name === manager ? undefined : true}
              className={`col-start-1 row-start-1 overflow-hidden text-ellipsis whitespace-nowrap ${
                name === manager ? '' : 'invisible'
              }`}
            >
              {commands[name]}
            </span>
          ))}
        </span>
        {copy}
      </div>
    </div>
  );
}

/** How long "Copied" stays up before the button says "Copy" again. */
const COPIED_MS = 2000;

function CopyButton({
  command,
  manager,
  package: pkg,
  location,
  className,
}: {
  command: string;
  manager: PackageManager;
  package: InstallPackage;
  location: string;
  className: string;
}) {
  // The command that was copied rather than a flag, so switching manager
  // while "Copied" is up reads as "Copy" again: it is a different command.
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const copied = copiedCommand === command;

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopiedCommand(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onClick() {
    // The command without its `$`, which is not part of what is typed.
    if (await copyText(command)) {
      setCopiedCommand(command);
      capture('command_copied', { location, manager, package: pkg });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label="Copy the install command"
        className={`min-w-[4.5rem] shrink-0 cursor-pointer border border-line-input bg-surface font-mono text-[12px] text-fg-body hover:text-fg-strong ${className}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* Outside the button, whose label would otherwise be what is announced. */}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}
