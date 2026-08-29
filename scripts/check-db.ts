/**
 * Prove a connection string works, without printing it.
 *
 *   MONGODB_URI='...' pnpm db:check
 *
 * WHAT IT IS FOR
 * --------------
 * Rotating the Atlas password. The safe order is to create a NEW database user,
 * verify it, and only then point the deploy at it — and "verify it" needs
 * something smaller than a deploy. A wrong credential discovered here costs a
 * second; discovered on Render it costs a failed deploy and a read of the logs.
 *
 * IT CANNOT WRITE
 * ---------------
 * Deliberately, and it is why this is not `pnpm seed` with a different
 * connection string. The seeder is a writer, and a writer pointed at an unknown
 * database to find out whether it works is how a test becomes an incident. This
 * runs two read-only commands and stops.
 *
 * IT NEVER PRINTS THE URI
 * -----------------------
 * The host and the authenticated user are shown, because those are what tell
 * you whether the new credential is the one in use. The password is not, on any
 * path including the failure one — a credential in a terminal is a credential
 * in the scrollback, and this exists to be run while rotating exactly that.
 */

import { getConfig } from '../src/platform/config/index.js';
import { closeMongo, getMongoClient, mongoHosts } from '../src/platform/mongo/index.js';

type ConnectionStatus = {
  authInfo?: { authenticatedUsers?: { user?: string; db?: string }[] };
};

const main = async (): Promise<void> => {
  const config = getConfig();
  const hosts = mongoHosts(config.mongo.uri);

  console.warn(`host      ${hosts.join(', ') || '(unreadable connection string)'}`);
  console.warn(`database  ${config.mongo.database}`);

  const client = await getMongoClient({ uri: config.mongo.uri, database: config.mongo.database });
  const db = client.db(config.mongo.database);

  await db.command({ ping: 1 });

  /*
   * Who the server thinks you are.
   *
   * The point of the whole exercise: after a rotation this must name the NEW
   * user. A ping alone would succeed just as happily on the old credential,
   * which is the one mistake this check exists to catch.
   */
  const status = (await db.admin().command({ connectionStatus: 1 })) as ConnectionStatus;
  const users = status.authInfo?.authenticatedUsers ?? [];

  const named = users.map((each) => `${each.user ?? '?'}@${each.db ?? '?'}`).join(', ');
  console.warn(`user      ${named || 'NONE — this connection is not authenticated'}`);

  // A read that needs a granted privilege, so a user with a connection but no
  // permission on this database fails here rather than looking healthy.
  const collections = await db.listCollections().toArray();
  console.warn(`readable  ${collections.length} collection(s)`);

  /*
   * Reported as what it is, rather than as success.
   *
   * A local mongod runs without authentication and answers everything happily.
   * Saying "connected and authenticated" there would be a check that passes for
   * a state which, against Atlas, means this is not the credential anyone
   * thinks it is — and confirming WHICH credential is in use is the entire job.
   */
  console.warn(
    named === ''
      ? '\nConnected and able to read, but NOT AUTHENTICATED. Normal for a local\n' +
          'server; against Atlas it means this is not the credential you think it is.'
      : `\nConnected as ${named}, and able to read. Safe to point the deploy at this.`,
  );
};

main()
  .catch((error: unknown) => {
    // The message only. A driver error can carry the whole connection string in
    // its stack, and this command is run while holding a credential worth
    // keeping out of a terminal.
    console.error('Could not use this connection string.');
    console.error(error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(closeMongo);
