import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import { config as appConfig } from '@/config';
import { HTTP_STATUS } from '@/http-status-codes';

const { NOT_FOUND } = HTTP_STATUS;

let s3Client: S3Client | null = null;

export function initializeS3(): S3Client {
  s3Client = new S3Client({
    region: appConfig.MINIO_REGION,
    endpoint: `http${appConfig.MINIO_USE_SSL ? 's' : ''}://${appConfig.MINIO_ENDPOINT}:${appConfig.MINIO_PORT}`,
    credentials: {
      accessKeyId: appConfig.MINIO_ACCESS_KEY,
      secretAccessKey: appConfig.MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  return s3Client;
}

export function getS3Client(): S3Client {
  if (!s3Client) {
    throw new Error('S3 client not initialized. Call initializeS3() first.');
  }
  return s3Client;
}

export async function createBucketIfNotExists(bucketName: string): Promise<void> {
  const client = getS3Client();

  try {
    // Check if bucket exists using HeadBucketCommand
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error: any) {
    // If bucket doesn't exist (404), create it
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === NOT_FOUND) {
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    } else {
      // For other errors (like connection errors), throw them
      throw error;
    }
  }
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType?: string
): Promise<{ etag: string; sha256: string }> {
  const client = getS3Client();
  const bodyBuffer = typeof body === 'string' ? Buffer.from(body) : body;
  const sha256 = createHash('sha256').update(bodyBuffer).digest('hex');

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bodyBuffer,
    ContentType: contentType,
    Metadata: {
      'x-sha256': sha256,
    },
  });

  const response = await client.send(command);
  return {
    etag: response.ETag || '',
    sha256,
  };
}

export async function putJson(bucket: string, key: string, data: any): Promise<{ etag: string; sha256: string }> {
  return putObject(bucket, key, JSON.stringify(data), 'application/json');
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);

  if (!response.Body) {
    throw new Error('Empty response body');
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as any) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function headObject(bucket: string, key: string): Promise<any> {
  const client = getS3Client();
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getPresignedUrl(
  bucket: string,
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

export async function getPresignedPutUrl(
  bucket: string,
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const client = getS3Client();
  const command = new PutObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

export function computeSha256(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data;
  return createHash('sha256').update(buffer).digest('hex');
}
