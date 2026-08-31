import { requireInteger, requireObject, requireString } from './fields';
import type { TzKTHttp } from './http';
import type { HeadSource } from '../confirmation';

export interface TzKTHead {
  readonly chainId: string;
  readonly level: number;
  readonly cycle: number;
  readonly protocol: string;
  readonly knownLevel: number;
}

/** `/v1/head`. Also the cheapest way to see how far behind the indexer is. */
export async function fetchHead(http: TzKTHttp): Promise<TzKTHead> {
  const { body } = await http.getRequired<Record<string, unknown>>('/v1/head');
  const head = requireObject(body, '/v1/head');
  return {
    chainId: requireString(head, 'chainId', '/v1/head'),
    level: requireInteger(head, 'level', '/v1/head'),
    cycle: requireInteger(head, 'cycle', '/v1/head'),
    protocol: requireString(head, 'protocol', '/v1/head'),
    knownLevel: requireInteger(head, 'knownLevel', '/v1/head'),
  };
}

export class TzKTHeadSource implements HeadSource {
  constructor(private readonly http: TzKTHttp) {}

  async getHeadLevel(): Promise<number> {
    return (await fetchHead(this.http)).level;
  }
}
