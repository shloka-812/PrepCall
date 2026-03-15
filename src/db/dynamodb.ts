/**
 * DynamoDB client — single-table design.
 * Supports local dev via DYNAMODB_ENDPOINT env var.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const TABLE_NAME = process.env.DYNAMODB_TABLE || 'granola-agent';

const ddbClient = new DynamoDBClient({
  ...(process.env.DYNAMODB_ENDPOINT && {
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
});

const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export async function getItem<T>(pk: string, sk: string): Promise<T | null> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
  }));
  return (result.Item as T) || null;
}

export async function putItem(
  pk: string,
  sk: string,
  data: Record<string, unknown>,
  ttlSeconds?: number,
): Promise<void> {
  const item: Record<string, unknown> = { PK: pk, SK: sk, ...data };
  if (ttlSeconds) {
    item.TTL = Math.floor(Date.now() / 1000) + ttlSeconds;
  }
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
  }));
}

export async function updateItem(
  pk: string,
  sk: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const expressionParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const key of keys) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    expressionParts.push(`${nameKey} = ${valueKey}`);
    names[nameKey] = key;
    values[valueKey] = updates[key];
  }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function queryByPk<T>(pk: string): Promise<T[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': pk },
  }));
  return (result.Items as T[]) || [];
}
