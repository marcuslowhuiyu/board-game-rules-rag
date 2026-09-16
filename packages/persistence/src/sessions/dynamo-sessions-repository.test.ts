import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSessionId,
  configurationFingerprint,
  type Session,
} from '@bgr/domain';
import { DynamoSessionsRepository } from './dynamo-sessions-repository.js';

const iso = '2026-09-16T00:00:00.000Z';

const session: Session = {
  sessionId: asSessionId('s_abc'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  enabledContentIds: [asContentId('c_pok')],
  configurationFingerprint: configurationFingerprint(asGameId('g_ti4'), asEditionId('e_1'), [
    asContentId('c_pok'),
  ]),
  createdAt: iso,
  updatedAt: iso,
  expiresAt: '2099-01-01T00:00:00.000Z',
  ttl: Math.floor(new Date('2099-01-01T00:00:00.000Z').getTime() / 1000),
};

describe('DynamoSessionsRepository', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  beforeEach(() => docMock.reset());

  const makeRepo = () =>
    new DynamoSessionsRepository(new DynamoDBClient({}), { sessionsTable: 'sessions' });

  it('createSession puts the session', async () => {
    docMock.on(PutCommand).resolves({});
    await makeRepo().createSession(session);
    const calls = docMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.Item).toEqual(session);
  });

  it('getSession returns null for missing item', async () => {
    docMock.on(GetCommand).resolves({});
    expect(await makeRepo().getSession(asSessionId('s_missing'))).toBeNull();
  });

  it('getSession filters out an expired session', async () => {
    docMock.on(GetCommand).resolves({ Item: { ...session, ttl: 1 } });
    expect(await makeRepo().getSession(session.sessionId)).toBeNull();
  });

  it('touch issues a conditional update', async () => {
    docMock.on(UpdateCommand).resolves({});
    await makeRepo().touch(session.sessionId, iso, iso, 999);
    const calls = docMock.commandCalls(UpdateCommand);
    expect(calls[0]!.args[0].input.ConditionExpression).toBe('attribute_exists(sessionId)');
  });

  it('deleteSession deletes the key', async () => {
    docMock.on(DeleteCommand).resolves({});
    await makeRepo().deleteSession(session.sessionId);
    const calls = docMock.commandCalls(DeleteCommand);
    expect(calls[0]!.args[0].input.Key).toEqual({ sessionId: session.sessionId });
  });
});
