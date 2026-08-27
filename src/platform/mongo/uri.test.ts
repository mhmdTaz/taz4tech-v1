import { describe, expect, it } from 'vitest';
import { isLocalMongo, mongoHosts } from './uri';

describe('reading the hosts out of a connection string', () => {
  it('finds a plain one', () => {
    expect(mongoHosts('mongodb://127.0.0.1:27017')).toEqual(['127.0.0.1']);
  });

  it('finds one behind credentials', () => {
    expect(mongoHosts('mongodb://user:pw@db.example.com:27017/taz4tech')).toEqual([
      'db.example.com',
    ]);
  });

  it('finds every member of a replica set', () => {
    expect(
      mongoHosts('mongodb://a.example.com:27017,b.example.com:27017/db?replicaSet=rs'),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('reads an SRV cluster', () => {
    expect(
      mongoHosts('mongodb+srv://user:pw@cluster0.abcde.mongodb.net/?appName=Cluster0'),
    ).toEqual(['cluster0.abcde.mongodb.net']);
  });

  it('unwraps an IPv6 literal', () => {
    expect(mongoHosts('mongodb://[::1]:27017/db')).toEqual(['::1']);
  });

  it('stops at the database, and at the options', () => {
    expect(mongoHosts('mongodb://host.example.com/taz4tech')).toEqual(['host.example.com']);
    expect(mongoHosts('mongodb://host.example.com?retryWrites=true')).toEqual(['host.example.com']);
  });

  it('lowercases, because DNS does not care and a Set does', () => {
    expect(mongoHosts('mongodb://LocalHost:27017')).toEqual(['localhost']);
  });

  it('drops the empty entry a trailing comma leaves behind', () => {
    // Malformed, but a stray comma must not produce a blank "host" that then
    // fails the loopback check and refuses a perfectly local database.
    expect(mongoHosts('mongodb://127.0.0.1:27017,')).toEqual(['127.0.0.1']);
  });

  it('keeps the port off an IPv6 address without eating the address', () => {
    // `::1` ends in something that looks exactly like a `:port`.
    expect(mongoHosts('mongodb://[::1]')).toEqual(['::1']);
    expect(mongoHosts('mongodb://[2001:db8::1]:27017/db')).toEqual(['2001:db8::1']);
  });

  it('finds nothing in something that is not a connection string', () => {
    // An empty list means UNKNOWN, not "no hosts" — isLocalMongo reads it that way.
    expect(mongoHosts('')).toEqual([]);
    expect(mongoHosts('postgres://localhost:5432')).toEqual([]);
    expect(mongoHosts('mongodb://')).toEqual([]);
  });
});

describe('deciding whether a database is on this machine', () => {
  it('says yes to loopback, however it is written', () => {
    expect(isLocalMongo('mongodb://localhost:27017')).toBe(true);
    expect(isLocalMongo('mongodb://127.0.0.1:27017/taz4tech_e2e')).toBe(true);
    expect(isLocalMongo('mongodb://[::1]:27017')).toBe(true);
  });

  it('says yes without a port', () => {
    expect(isLocalMongo('mongodb://localhost')).toBe(true);
  });

  it('says NO to an Atlas cluster', () => {
    expect(isLocalMongo('mongodb+srv://user:pw@cluster0.abcde.mongodb.net/?appName=X')).toBe(false);
  });

  it('says no to any other host', () => {
    expect(isLocalMongo('mongodb://db.example.com:27017')).toBe(false);
    expect(isLocalMongo('mongodb://10.0.0.5:27017')).toBe(false);
  });

  it('is not fooled by "localhost" appearing in a PASSWORD', () => {
    /*
     * The reason this is parsed rather than searched. `uri.includes('localhost')`
     * answers yes here, and the guard that exists to keep fixtures out of a real
     * shop waves them straight through.
     */
    expect(isLocalMongo('mongodb://admin:localhost@cluster.example.com:27017/db')).toBe(false);
  });

  it('is not fooled by "localhost" appearing in a hostname', () => {
    expect(isLocalMongo('mongodb://localhost.evil.example.com:27017')).toBe(false);
  });

  it('is not fooled by "localhost" appearing in the OPTIONS', () => {
    expect(isLocalMongo('mongodb://db.example.com:27017/x?appName=localhost')).toBe(false);
  });

  it('calls a replica set remote when ANY member is', () => {
    // Writing to it writes to the remote member.
    expect(isLocalMongo('mongodb://127.0.0.1:27017,db.example.com:27017/x?replicaSet=rs')).toBe(
      false,
    );
  });

  it('calls anything it cannot read remote', () => {
    // "I do not know" has to read as "assume it is production". The cost of a
    // wrong yes is fixtures in a real shop; the cost of a wrong no is typing one
    // environment variable.
    expect(isLocalMongo('')).toBe(false);
    expect(isLocalMongo('not a uri')).toBe(false);
    expect(isLocalMongo('mongodb://')).toBe(false);
  });

  it('does not treat 0.0.0.0 as local', () => {
    // Deliberately absent from the list: it is "local" in some setups and a
    // guess in others, and every guess here fails towards refusing.
    expect(isLocalMongo('mongodb://0.0.0.0:27017')).toBe(false);
  });
});
