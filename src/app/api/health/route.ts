import { getContainer } from '@/composition';

/**
 * Health check, consumed by Render's healthCheckPath during a deploy.
 *
 * It verifies the database too, not just that the process is up. A deploy whose
 * connection string is wrong should fail while the previous version is still
 * serving, rather than go live and return errors to customers — which is exactly
 * what a process-only check would allow.
 *
 * Deliberately unrevealing on failure: no connection string, no host, no stack.
 * The detail goes to the structured log, where it is already redacted.
 */
export async function GET(): Promise<Response> {
  try {
    const container = await getContainer();
    await container.db.command({ ping: 1 });

    return Response.json(
      { status: 'ok', storeId: container.config.storeId },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // Logged here rather than rethrown: the response must stay generic, but a
    // failing deploy needs a readable reason in the Render log.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'health check failed',
        reason: error instanceof Error ? error.message : 'unknown',
      }),
    );

    return Response.json(
      { status: 'unhealthy' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
