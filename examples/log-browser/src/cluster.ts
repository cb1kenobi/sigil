/**
 * The simulated cluster: pods, services and deployments, and the log lines the
 * pods write.
 *
 * Nothing here reads a clock or `Math.random()`. Time is the cluster's own,
 * starting at {@link EPOCH} and moved on by {@link Cluster.advance}, and every
 * choice comes from a seeded generator -- so two clusters built with one seed and
 * advanced by the same steps are the same cluster, line for line. That is what
 * lets the smoke test compare the two syntaxes' first screens, and what lets a
 * test press a key and know which line is under the cursor.
 *
 * Pure data: no signals, no elements. `browser.ts` holds it in state.
 */

import type { LogLine } from './logs.ts';

/** Where the cluster's clock starts: 09:00 UTC, the day this example was written. */
export const EPOCH: number = Date.UTC(2026, 10, 10, 9, 0, 0);

/** What a pod is doing, as `kubectl get pods` says it. */
export type PodStatus = 'ContainerCreating' | 'CrashLoopBackOff' | 'Pending' | 'Running';

export interface Pod {
  readonly app: string;
  /** Millicores, as `kubectl top` reads them. */
  readonly cpu: number;
  readonly image: string;
  readonly ip: string;
  /** Mebibytes. */
  readonly memory: number;
  readonly name: string;
  readonly namespace: string;
  readonly node: string;
  readonly restarts: number;
  /** When the pod started, on the cluster's clock. */
  readonly started: number;
  readonly status: PodStatus;
}

export interface Service {
  readonly clusterIp: string;
  readonly created: number;
  readonly name: string;
  readonly namespace: string;
  readonly ports: string;
  readonly type: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
}

export interface Deployment {
  readonly available: number;
  readonly created: number;
  readonly desired: number;
  readonly image: string;
  readonly name: string;
  readonly namespace: string;
  readonly ready: number;
}

/** The three kinds of resource the browser lists. */
export type Kind = 'deployments' | 'pods' | 'services';

/** A deterministic generator: the same seed is the same sequence, on every machine. */
export function random(seed: number): () => number {
  let n = seed >>> 0;
  return () => {
    n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
    return n / 2_147_483_648;
  };
}

/** One app the cluster runs: where, how many, and what its log lines say. */
interface App {
  readonly image: string;
  readonly name: string;
  readonly namespace: string;
  readonly port: string;
  readonly replicas: number;
  readonly type: Service['type'];
}

const APPS: readonly App[] = [
  {
    image: 'api:1.14.2',
    name: 'api',
    namespace: 'default',
    port: '8080/TCP',
    replicas: 3,
    type: 'ClusterIP',
  },
  {
    image: 'web:3.2.0',
    name: 'web',
    namespace: 'default',
    port: '80/TCP,443/TCP',
    replicas: 2,
    type: 'LoadBalancer',
  },
  {
    image: 'worker:1.14.2',
    name: 'worker',
    namespace: 'default',
    port: '9000/TCP',
    replicas: 4,
    type: 'ClusterIP',
  },
  {
    image: 'billing:0.9.1',
    name: 'billing',
    namespace: 'payments',
    port: '8443/TCP',
    replicas: 2,
    type: 'ClusterIP',
  },
  {
    image: 'ledger:2.0.4',
    name: 'ledger',
    namespace: 'payments',
    port: '5000/TCP',
    replicas: 1,
    type: 'ClusterIP',
  },
  {
    image: 'postgres:16.4',
    name: 'postgres',
    namespace: 'data',
    port: '5432/TCP',
    replicas: 1,
    type: 'ClusterIP',
  },
  {
    image: 'redis:7.4',
    name: 'redis',
    namespace: 'data',
    port: '6379/TCP',
    replicas: 1,
    type: 'ClusterIP',
  },
  {
    image: 'prometheus:2.55',
    name: 'prometheus',
    namespace: 'monitoring',
    port: '9090/TCP',
    replicas: 1,
    type: 'NodePort',
  },
  {
    image: 'grafana:11.3',
    name: 'grafana',
    namespace: 'monitoring',
    port: '3000/TCP',
    replicas: 1,
    type: 'NodePort',
  },
  {
    image: 'coredns:1.11',
    name: 'coredns',
    namespace: 'kube-system',
    port: '53/UDP,53/TCP',
    replicas: 2,
    type: 'ClusterIP',
  },
];

const NODES = ['node-1', 'node-2', 'node-3'];

/** What each app says, by level. `#` is a number, `%` an id. */
const SAYS: Record<string, Partial<Record<LogLine['level'], readonly string[]>>> = {
  api: {
    debug: ['cache hit key=order:%', 'pool size=# idle=#'],
    error: ['upstream ledger: connection refused', 'GET /v1/orders/% 500 #ms'],
    info: ['GET /v1/orders/% 200 #ms', 'POST /v1/orders 201 #ms', 'GET /healthz 200 #ms'],
    warn: ['slow query on orders took #ms', 'GET /v1/orders/% 429 rate limited'],
  },
  billing: {
    error: ['invoice inv_% failed: card declined'],
    info: ['charged invoice inv_% $#.00', 'webhook delivered evt_%'],
    warn: ['retrying webhook evt_% (attempt #)'],
  },
  coredns: {
    debug: ['[INFO] # "A IN api.default.svc.cluster.local. udp" NOERROR'],
    info: ['[INFO] plugin/reload: Running configuration SHA512 = %'],
  },
  grafana: { info: ['Request Completed path=/api/dashboards/uid/% status=200'] },
  ledger: {
    error: ['commit % aborted: serialization failure'],
    info: ['posted entry % to account #', 'balance check ok for account #'],
  },
  postgres: {
    info: [
      'checkpoint complete: wrote # buffers',
      'connection authorized: user=app database=orders',
    ],
    warn: ['could not receive data from client: Connection reset by peer'],
  },
  prometheus: {
    info: ['Scrape completed target=% samples=#'],
    warn: ['Scrape timed out target=%'],
  },
  redis: { info: ['DB saved on disk', 'Background saving started by pid #'] },
  web: {
    info: ['GET / 200 #ms', 'GET /assets/app.% 304 #ms'],
    warn: ['GET /account 401 #ms'],
  },
  worker: {
    debug: ['polling queue jobs depth=#'],
    error: ['job % failed: timeout after #ms'],
    info: ['job % done in #ms', 'picked up job %'],
    warn: ['retrying job % (attempt #)'],
  },
};

/** How often each level comes up, out of a hundred. */
const LEVEL_ODDS: readonly [LogLine['level'], number][] = [
  ['debug', 25],
  ['info', 60],
  ['warn', 10],
  ['error', 5],
];

/** A clock reading as `kubectl` does: `HH:MM:SS.mmm`, in UTC so a test reads the same anywhere. */
export function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

/** An age as `kubectl get` prints it: `42s`, `17m`, `5h`, `3d`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) {
    return `${s}s`;
  }
  if (s < 120 * 60) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 48 * 3600) {
    return `${Math.floor(s / 3600)}h`;
  }
  return `${Math.floor(s / 86_400)}d`;
}

/** A simulated cluster. */
export interface Cluster {
  /**
   * Moves the cluster's clock on: the pods' readings change once a second, a pod
   * now and then restarts or crashes, and the pods write log lines.
   *
   * @param ms - How much time passes.
   * @returns The log lines written in that time, oldest first.
   */
  advance(ms: number): LogLine[];
  /**
   * Log lines from before the cluster's clock started, oldest first, ending at
   * the current time: the history a log view opens on.
   */
  backlog(count: number): LogLine[];
  deployments(): readonly Deployment[];
  /** `kubectl describe` for one resource, as the lines a pager shows. */
  describe(kind: Kind, name: string): string;
  /** The cluster's clock. */
  now(): number;
  pods(): readonly Pod[];
  services(): readonly Service[];
}

/**
 * Builds a cluster.
 *
 * @param opts - The seed, and the id the first log line takes.
 * @returns The cluster, at {@link EPOCH}.
 */
export function createCluster(opts: { nextId?: () => number; seed?: number } = {}): Cluster {
  const roll = random(opts.seed ?? 42);
  let id = 0;
  const nextId = opts.nextId ?? (() => id++);
  let now = EPOCH;

  const pick = <T>(items: readonly T[]): T => items[Math.floor(roll() * items.length)] as T;
  const suffix = (n: number): string =>
    Array.from({ length: n }, () => pick([...'bcdfghjklmnpqrstvwxz2456789'])).join('');
  const ip = (): string => `10.42.${1 + Math.floor(roll() * 3)}.${2 + Math.floor(roll() * 250)}`;

  const created = new Map<string, number>();
  for (const app of APPS) {
    created.set(app.name, EPOCH - (2 + Math.floor(roll() * 20)) * 86_400_000);
  }

  const hashes = new Map(APPS.map((app) => [app.name, suffix(5)]));
  const spawn = (app: App, at: number, status: PodStatus = 'Running'): Pod => ({
    app: app.name,
    cpu: 5 + Math.floor(roll() * 200),
    image: `registry.local/${app.image}`,
    ip: ip(),
    memory: 32 + Math.floor(roll() * 480),
    name: `${app.name}-${hashes.get(app.name)}-${suffix(5)}`,
    namespace: app.namespace,
    node: pick(NODES),
    restarts: 0,
    started: at,
    status,
  });

  let pods: Pod[] = APPS.flatMap((app) =>
    Array.from({ length: app.replicas }, () =>
      spawn(app, EPOCH - Math.floor(roll() * 6 * 86_400_000))
    )
  );
  /** Pods on their way to `Running`, and the second each gets there. */
  const settling = new Map<string, number>();

  const services: Service[] = APPS.map((app) => ({
    clusterIp: `10.96.${Math.floor(roll() * 255)}.${Math.floor(roll() * 255)}`,
    created: created.get(app.name) as number,
    name: app.name,
    namespace: app.namespace,
    ports: app.port,
    type: app.type,
  }));

  const deployments = (): Deployment[] =>
    APPS.map((app) => {
      const mine = pods.filter((p) => p.app === app.name);
      const ready = mine.filter((p) => p.status === 'Running').length;
      return {
        available: ready,
        created: created.get(app.name) as number,
        desired: app.replicas,
        image: `registry.local/${app.image}`,
        name: app.name,
        namespace: app.namespace,
        ready,
      };
    });

  /** One line from a pod that is up, at a time. */
  const line = (at: number): LogLine => {
    const up = pods.filter((p) => p.status === 'Running' || p.status === 'CrashLoopBackOff');
    const pod = pick(up.length > 0 ? up : pods);
    const says = SAYS[pod.app] ?? {};
    let level: LogLine['level'] = 'info';
    let n = roll() * 100;
    for (const [name, odds] of LEVEL_ODDS) {
      if (n < odds && says[name] !== undefined) {
        level = name;
        break;
      }
      n -= odds;
    }
    if (pod.status === 'CrashLoopBackOff' && says.error !== undefined) {
      level = 'error';
    }
    const template = pick(says[level] ?? says.info ?? ['ok']);
    const message = template
      .replaceAll('#', () => String(1 + Math.floor(roll() * 900)))
      .replaceAll('%', () => suffix(6));
    return {
      id: nextId(),
      level,
      source: pod.name,
      text: `${clockTime(at)} ${level.toUpperCase().padEnd(5)} ${pod.name} ${message}`,
    };
  };

  /** A second passing over the pods: new readings, a restart now and then. */
  const second = (): void => {
    const at = now;
    pods = pods.map((pod) => {
      const due = settling.get(pod.name);
      if (due !== undefined && at >= due) {
        settling.delete(pod.name);
        return { ...pod, cpu: 20, status: 'Running' };
      }
      if (pod.status !== 'Running') {
        if (pod.status === 'Pending' && due !== undefined && at >= due - 4000) {
          return { ...pod, status: 'ContainerCreating' };
        }
        return pod;
      }
      const r = roll();
      if (r < 0.004) {
        // a crash: it comes back after a few seconds, one restart the richer
        settling.set(pod.name, at + 8000);
        return { ...pod, cpu: 0, restarts: pod.restarts + 1, status: 'CrashLoopBackOff' };
      }
      const cpu = Math.max(1, Math.round(pod.cpu + (roll() - 0.5) * 40));
      const memory = Math.max(16, Math.round(pod.memory + (roll() - 0.5) * 8));
      return { ...pod, cpu, memory };
    });
    if (roll() < 0.01) {
      // a rollout replaces one worker: the old pod goes, a new one starts pending
      const worker = APPS.find((app) => app.name === 'worker') as App;
      const old = pods.findIndex((p) => p.app === 'worker' && p.status === 'Running');
      if (old >= 0) {
        const fresh = spawn(worker, at, 'Pending');
        settling.set(fresh.name, at + 9000);
        pods = [...pods.slice(0, old), ...pods.slice(old + 1), fresh];
      }
    }
  };

  /** Milliseconds into the current second, so that `advance()` ticks the pods on the second. */
  let carried = 0;

  return {
    advance(ms) {
      const out: LogLine[] = [];
      let left = ms;
      while (left > 0) {
        const step = Math.min(left, 1000 - carried);
        // about ten lines a second, written at moments inside the step
        const count = Math.floor((step / 1000) * 10 * (0.4 + roll() * 1.2));
        const times = Array.from({ length: count }, () => now + Math.floor(roll() * step)).sort(
          (a, b) => a - b
        );
        for (const at of times) {
          out.push(line(at));
        }
        now += step;
        carried += step;
        left -= step;
        if (carried >= 1000) {
          carried = 0;
          second();
        }
      }
      return out;
    },
    backlog(count) {
      // spread over the time before now, about twenty lines a second
      let at = now - count * 50;
      return Array.from({ length: count }, () => {
        at = Math.min(now, at + Math.floor(roll() * 100));
        return line(at);
      });
    },
    deployments,
    describe(kind, name) {
      return describeResource(kind, name, { deployments: deployments(), now, pods, services });
    },
    now: () => now,
    pods: () => pods,
    services: () => services,
  };
}

/** `kubectl describe`, near enough, for one resource. */
function describeResource(
  kind: Kind,
  name: string,
  at: {
    deployments: readonly Deployment[];
    now: number;
    pods: readonly Pod[];
    services: readonly Service[];
  }
): string {
  const field = (label: string, value: string | number): string =>
    `${`${label}:`.padEnd(16)}${value}`;
  const when = (ms: number): string => new Date(ms).toISOString().replace('.000', '');

  if (kind === 'pods') {
    const pod = at.pods.find((p) => p.name === name);
    if (pod === undefined) {
      return `pod ${name} is gone`;
    }
    return [
      field('Name', pod.name),
      field('Namespace', pod.namespace),
      field('Node', pod.node),
      field('Start Time', when(pod.started)),
      field('Labels', `app=${pod.app}`),
      field('Status', pod.status),
      field('IP', pod.ip),
      'Containers:',
      `  ${pod.app}:`,
      `    ${field('Image', pod.image)}`,
      `    ${field('State', pod.status === 'Running' ? 'Running' : 'Waiting')}`,
      `    ${field('Restart Count', pod.restarts)}`,
      `    ${field('Requests', 'cpu: 100m, memory: 128Mi')}`,
      `    ${field('Limits', 'cpu: 500m, memory: 512Mi')}`,
      `    ${field('Usage', `cpu: ${pod.cpu}m, memory: ${pod.memory}Mi`)}`,
      'Conditions:',
      '  Type              Status',
      `  Initialized       True`,
      `  Ready             ${pod.status === 'Running' ? 'True' : 'False'}`,
      `  PodScheduled      True`,
      'Events:',
      '  Type    Reason     Age   Message',
      `  Normal  Scheduled  ${age(at.now - pod.started).padEnd(5)} Successfully assigned ${pod.namespace}/${pod.name} to ${pod.node}`,
      `  Normal  Pulled     ${age(at.now - pod.started).padEnd(5)} Container image "${pod.image}" already present on machine`,
      `  Normal  Started    ${age(at.now - pod.started).padEnd(5)} Started container ${pod.app}`,
      ...(pod.restarts > 0
        ? [`  Warning BackOff    ${'1m'.padEnd(5)} Back-off restarting failed container ${pod.app}`]
        : []),
    ].join('\n');
  }

  if (kind === 'services') {
    const svc = at.services.find((s) => s.name === name);
    if (svc === undefined) {
      return `service ${name} is gone`;
    }
    const endpoints = at.pods
      .filter((p) => p.app === svc.name && p.status === 'Running')
      .map((p) => `${p.ip}:${svc.ports.split('/')[0]}`);
    return [
      field('Name', svc.name),
      field('Namespace', svc.namespace),
      field('Labels', `app=${svc.name}`),
      field('Selector', `app=${svc.name}`),
      field('Type', svc.type),
      field('IP', svc.clusterIp),
      field('Port', svc.ports),
      field('Endpoints', endpoints.join(',') || '<none>'),
      field('Created', when(svc.created)),
      'Events:          <none>',
    ].join('\n');
  }

  const deploy = at.deployments.find((d) => d.name === name);
  if (deploy === undefined) {
    return `deployment ${name} is gone`;
  }
  return [
    field('Name', deploy.name),
    field('Namespace', deploy.namespace),
    field('Created', when(deploy.created)),
    field('Selector', `app=${deploy.name}`),
    field(
      'Replicas',
      `${deploy.desired} desired | ${deploy.desired} updated | ${deploy.desired} total | ${deploy.available} available | ${deploy.desired - deploy.available} unavailable`
    ),
    field('StrategyType', 'RollingUpdate'),
    'Pod Template:',
    `  ${field('Labels', `app=${deploy.name}`)}`,
    '  Containers:',
    `   ${deploy.name}:`,
    `    ${field('Image', deploy.image)}`,
    'Conditions:',
    '  Type           Status  Reason',
    `  Available      ${deploy.available === deploy.desired ? 'True ' : 'False'}   MinimumReplicasAvailable`,
    '  Progressing    True    NewReplicaSetAvailable',
  ].join('\n');
}
