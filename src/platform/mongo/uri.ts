/**
 * Reading a MongoDB connection string, without connecting to it.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Some scripts must not run against a real database. `pnpm seed:demo` writes
 * three fake laptops and a cable, three of them ACTIVE — on a production
 * catalogue that is four products a customer can buy. The only thing standing
 * between a developer with `.env.local` pointing at Atlas and that outcome is
 * this file answering "is that a laptop or a cluster".
 *
 * So it is parsing, not string matching. `uri.includes('localhost')` says yes to
 * `mongodb://user:localhost@cluster0.mongodb.net`, which is a password, and the
 * guard that was supposed to protect production would wave it through. Getting
 * this wrong is silent in exactly the direction that costs something, which is
 * why it lives here with tests rather than inline in a script.
 *
 * It never touches the network. An SRV URI is treated as remote by its scheme
 * alone: resolving it would mean a DNS lookup, and a hostname that needs a
 * cluster to exist is not somebody's laptop.
 */

/**
 * Loopback only.
 *
 * `0.0.0.0` and `host.docker.internal` are deliberately absent. Both are "local"
 * in some setups, and both would be a guess — and every guess in this file has
 * to fail towards refusing, because the cost of a wrong "yes" is fixtures in a
 * real shop and the cost of a wrong "no" is typing one environment variable.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

const SCHEME = /^mongodb(\+srv)?:\/\//i;

/**
 * Strip the port, and the brackets an IPv6 literal is written with.
 *
 * The two cases cannot share one expression: `::1` ends in something that looks
 * exactly like a `:port`, so the rule that strips a port has to be kept away
 * from an address that is mostly colons.
 */
const hostOf = (hostAndPort: string): string =>
  (hostAndPort.startsWith('[')
    ? hostAndPort.replace(/^\[(.+)\].*$/, '$1')
    : hostAndPort.replace(/:\d+$/, '')
  ).toLowerCase();

/**
 * Every host in a connection string. A replica set lists several.
 *
 * Returns an empty list for anything unparseable, which callers must read as
 * "unknown" rather than "none" — see isLocalMongo.
 */
export const mongoHosts = (uri: string): readonly string[] => {
  if (!SCHEME.test(uri)) return [];

  // The database and the options come after the authority; a password containing
  // either separator has to be percent-encoded, so cutting at the first one is
  // safe. Not `split`, which would need an index and a fallback that can never
  // happen — a branch the coverage gate would then demand a test for.
  const rest = uri.replace(SCHEME, '');
  const end = rest.search(/[/?]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.length === 0) return [];

  // The LAST @, not the first: credentials come before the hosts, and while an
  // @ inside a password must be percent-encoded, cutting at the last one costs
  // nothing and survives a URI that broke that rule.
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);

  return hosts
    .split(',')
    .map((each) => hostOf(each.trim()))
    .filter((host) => host.length > 0);
};

/**
 * Is every host on this machine?
 *
 * `every`, not `some`: a replica set that lists localhost alongside a remote
 * member is remote, and writing to it writes to the remote one.
 *
 * A URI with no hosts this can find is NOT local. That covers a typo, a shape
 * nobody anticipated, and an empty string — all cases where the honest answer is
 * "I do not know", and where the safe reading of "I do not know" is "assume it
 * is production".
 */
export const isLocalMongo = (uri: string): boolean => {
  if (/^mongodb\+srv:/i.test(uri)) return false;

  const hosts = mongoHosts(uri);
  return hosts.length > 0 && hosts.every((host) => LOOPBACK.has(host));
};
