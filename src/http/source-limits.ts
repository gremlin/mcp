import { BlockList, isIP } from 'node:net';

import type { SharedStore } from '../shared-store';

/**
 * Sources whose traffic is many users rather than one caller -- an LLM vendor's egress, whose every
 * user of a hosted connector reaches this server from the same few addresses.
 *
 * <p>Keyed on address alone, such a source is indistinguishable from one attacker, so the ordinary
 * per-source bound would make its users throttle each other. A trusted source gets a raised bound
 * of its own instead: still a wall between it and everyone else, sized for a crowd.
 *
 * <p>Configured by `GREMLIN_MCP_TRUSTED_SOURCE_CIDRS`. There is no compiled default -- which vendors
 * a deployment fronts is not knowable at build time -- and unset means no source is trusted.
 */
export function trustedSourcesFrom(ranges: SourceRange[]): BlockList {
  const trusted = new BlockList();
  for (const { address, prefix, type } of ranges) {
    if (prefix === undefined) trusted.addAddress(address, type);
    else trusted.addSubnet(address, prefix, type);
  }
  return trusted;
}

export interface SourceRange {
  address: string;
  prefix?: number;
  type: 'ipv4' | 'ipv6';
}

/** One CIDR range or single address, or undefined when it does not parse. */
export function parseSourceRange(entry: string): SourceRange | undefined {
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return undefined;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (prefix === undefined) return { address, type };
  const bits = Number(prefix);
  if (prefix === '' || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
    return undefined;
  }
  return { address, prefix: bits, type };
}

/** Whether a source key is an address inside one of the trusted ranges. */
export function isTrustedSource(trusted: BlockList, source: string): boolean {
  const bare = source.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  const address = mapped ? mapped[1] : bare;
  const family = isIP(address);
  if (family === 0) return false;
  return trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Counts events per source in fixed windows and says when a source has used its allowance.
 *
 * <p>Counts live in a {@link SharedStore}. With a shared one, every instance counts into the same
 * window -- windows are aligned to the epoch, not to this process -- so the bound is fleet-wide.
 * With a private one it bounds this instance's own work. Each window's counter expires with it.
 */
export class SourceRateLimiter {
  constructor(
    private readonly name: string,
    private readonly store: SharedStore,
    private readonly windowMs: number,
    private readonly perSource: number,
    private readonly perTrustedSource: number,
    private readonly trusted: BlockList,
  ) {}

  /** Records one event for `source`; true when that source was already at its bound. */
  async exceeded(source: string, now: number): Promise<boolean> {
    const window = Math.floor(now / this.windowMs);
    const used = await this.store.increment(
      `rl:${this.name}:${source}:${window}`,
      (window + 1) * this.windowMs - now,
    );
    const bound = isTrustedSource(this.trusted, source) ? this.perTrustedSource : this.perSource;
    return used > bound;
  }
}
