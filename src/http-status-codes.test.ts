import { describe, it, expect } from 'vitest';
import {
  HTTP_STATUS,
  HTTP_STATUS_BY_CODE,
  HTTP_STATUS_CODES,
  getStatusInfo,
  isClientError,
  isServerError,
} from '@/http-status-codes';

const keyFor = (text: string) => text.replace(/'/g, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

describe('HTTP status codes module', () => {
  it('keeps list and map in sync', () => {
    expect(HTTP_STATUS_CODES.length).toBe(Object.keys(HTTP_STATUS_BY_CODE).length);

    for (const status of HTTP_STATUS_CODES) {
      expect(HTTP_STATUS_BY_CODE[status.code]).toEqual(status);
      expect(HTTP_STATUS[keyFor(status.text)]).toBe(status.code);
    }
  });

  it('exposes correct metadata for representative codes', () => {
    const samples = [
      { code: HTTP_STATUS.OK, text: 'OK', description: 'Request succeeded.' },
      {
        code: HTTP_STATUS.CREATED,
        text: 'Created',
        description: 'Request succeeded and a new resource was created.',
      },
      { code: HTTP_STATUS.BAD_REQUEST, text: 'Bad Request', description: 'Request is invalid or malformed.' },
      { code: HTTP_STATUS.NOT_FOUND, text: 'Not Found', description: 'Requested resource could not be found.' },
      { code: HTTP_STATUS.INTERNAL_SERVER_ERROR, text: 'Internal Server Error', description: 'Generic server error.' },
      { code: HTTP_STATUS.SERVICE_UNAVAILABLE, text: 'Service Unavailable', description: 'Server is temporarily unable to handle the request.' },
    ];

    for (const sample of samples) {
      const info = getStatusInfo(sample.code);
      expect(info).toBeDefined();
      expect(info?.text).toBe(sample.text);
      expect(info?.description).toBe(sample.description);
    }
  });

  it('classifies client and server errors correctly', () => {
    expect(isClientError(HTTP_STATUS.BAD_REQUEST)).toBe(true);
    expect(isClientError(HTTP_STATUS.NOT_FOUND)).toBe(true);
    expect(isClientError(HTTP_STATUS.CREATED)).toBe(false);

    expect(isServerError(HTTP_STATUS.INTERNAL_SERVER_ERROR)).toBe(true);
    expect(isServerError(HTTP_STATUS.SERVICE_UNAVAILABLE)).toBe(true);
    expect(isServerError(HTTP_STATUS.BAD_GATEWAY)).toBe(true);
    expect(isServerError(HTTP_STATUS.OK)).toBe(false);
  });
});
