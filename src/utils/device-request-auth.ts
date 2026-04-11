import { createVerify, randomBytes, X509Certificate } from 'crypto';
import forge from 'node-forge';
import { config } from '@/config';
import { AppError } from '@/utils/app-error';

export const DEVICE_REQUEST_SIGNATURE_VERSION = 'v1';
const DEVICE_REQUEST_SIGNATURE_PREFIX = 'HEXMON_DEVICE_AUTH_V1';
const DEVICE_AUTH_MODES = ['legacy', 'dual', 'signature'] as const;

export type DeviceAuthMode = (typeof DEVICE_AUTH_MODES)[number];

export type ParsedDeviceRequestSignatureHeaders = {
  serial: string | null;
  version: string | null;
  timestamp: string | null;
  signature: string | null;
};

function readHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function parseDeviceRequestSignatureHeaders(
  headers: Record<string, string | string[] | undefined>
): ParsedDeviceRequestSignatureHeaders {
  return {
    serial:
      readHeaderValue(headers['x-device-serial']) ||
      readHeaderValue(headers['x-device-cert-serial']) ||
      readHeaderValue(headers['x-device-cert']),
    version: readHeaderValue(headers['x-device-auth-version']),
    timestamp: readHeaderValue(headers['x-device-timestamp']),
    signature: readHeaderValue(headers['x-device-signature']),
  };
}

export function hasAnySignatureHeader(headers: ParsedDeviceRequestSignatureHeaders) {
  return Boolean(headers.version || headers.timestamp || headers.signature);
}

export function hasCompleteSignatureHeaders(headers: ParsedDeviceRequestSignatureHeaders) {
  return Boolean(headers.serial && headers.version && headers.timestamp && headers.signature);
}

export function resolveDeviceAuthMode(): DeviceAuthMode {
  const requested =
    process.env.HEXMON_DEVICE_AUTH_MODE?.trim().toLowerCase() ||
    process.env.DEVICE_AUTH_MODE?.trim().toLowerCase() ||
    config.DEVICE_AUTH_MODE;

  if ((DEVICE_AUTH_MODES as readonly string[]).includes(requested)) {
    return requested as DeviceAuthMode;
  }

  return config.DEVICE_AUTH_MODE;
}

export function resolveDeviceAuthSignatureMaxSkewSeconds() {
  const raw =
    process.env.HEXMON_DEVICE_AUTH_SIGNATURE_MAX_SKEW_SECONDS?.trim() ||
    process.env.DEVICE_AUTH_SIGNATURE_MAX_SKEW_SECONDS?.trim();
  if (!raw) return config.DEVICE_AUTH_SIGNATURE_MAX_SKEW_SECONDS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.DEVICE_AUTH_SIGNATURE_MAX_SKEW_SECONDS;
}

export function buildDeviceRequestSignaturePayload(params: {
  method: string;
  url: string;
  deviceId: string;
  timestamp: string;
}) {
  return [
    DEVICE_REQUEST_SIGNATURE_PREFIX,
    params.method.trim().toUpperCase(),
    params.url.trim(),
    params.deviceId.trim(),
    params.timestamp.trim(),
  ].join('\n');
}

export function verifyDeviceRequestSignature(params: {
  method: string;
  url: string;
  deviceId: string;
  timestamp: string;
  signature: string;
  publicKeyPem: string;
  version: string;
}) {
  if (params.version !== DEVICE_REQUEST_SIGNATURE_VERSION) {
    throw AppError.forbidden('Unsupported device auth signature version', {
      reason: 'DEVICE_SIGNATURE_VERSION_UNSUPPORTED',
      version: params.version,
    });
  }

  const payload = buildDeviceRequestSignaturePayload({
    method: params.method,
    url: params.url,
    deviceId: params.deviceId,
    timestamp: params.timestamp,
  });

  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(payload);
    verifier.end();
    return verifier.verify(params.publicKeyPem, params.signature, 'base64');
  } catch {
    return false;
  }
}

export function extractDeviceAuthPublicKeyFromCsr(csrPem: string) {
  try {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) {
      throw AppError.badRequest('CSR verification failed');
    }
    if (!csr.publicKey) {
      throw AppError.badRequest('CSR is missing a public key');
    }

    const commonNameField = csr.subject.getField('CN') ?? csr.subject.getField('commonName');
    const subjectCommonName =
      typeof commonNameField?.value === 'string' && commonNameField.value.trim().length > 0
        ? commonNameField.value.trim()
        : null;

    if (!subjectCommonName) {
      throw AppError.badRequest('CSR subject commonName is required');
    }

    const rsaPublicKey = csr.publicKey as forge.pki.rsa.PublicKey & { n?: forge.jsbn.BigInteger };
    const rsaBits = typeof rsaPublicKey?.n?.bitLength === 'function' ? rsaPublicKey.n.bitLength() : null;
    if (rsaBits != null && rsaBits < 2048) {
      throw AppError.badRequest('CSR RSA public key must be at least 2048 bits');
    }

    return {
      publicKeyPem: forge.pki.publicKeyToPem(csr.publicKey),
      subjectCommonName,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw AppError.badRequest('Invalid CSR format');
  }
}

function generateCertificateSerialNumber() {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0] & 0x7f;
  if (bytes.every((value) => value === 0)) {
    bytes[bytes.length - 1] = 1;
  }
  return bytes.toString('hex').toUpperCase();
}

export function issueDeviceCertificateFromCsr(params: {
  csrPem: string;
  caCertPem: string;
  caKeyPem: string;
  notBefore?: Date;
  notAfter: Date;
}) {
  try {
    const csr = forge.pki.certificationRequestFromPem(params.csrPem);
    if (!csr.verify()) {
      throw AppError.badRequest('CSR verification failed');
    }
    if (!csr.publicKey) {
      throw AppError.badRequest('CSR is missing a public key');
    }

    const caCert = forge.pki.certificateFromPem(params.caCertPem);
    const caPrivateKey = forge.pki.privateKeyFromPem(params.caKeyPem);

    const certificate = forge.pki.createCertificate();
    certificate.publicKey = csr.publicKey;
    certificate.serialNumber = generateCertificateSerialNumber();
    certificate.validity.notBefore = params.notBefore ?? new Date(Date.now() - 5 * 60 * 1000);
    certificate.validity.notAfter = params.notAfter;
    certificate.setSubject(csr.subject.attributes);
    certificate.setIssuer(caCert.subject.attributes);
    certificate.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        dataEncipherment: false,
        keyCertSign: false,
      },
      {
        name: 'extKeyUsage',
        clientAuth: true,
      },
      {
        name: 'subjectKeyIdentifier',
      },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: true,
        authorityCertIssuer: true,
        serialNumber: caCert.serialNumber,
      },
    ]);
    certificate.sign(caPrivateKey, forge.md.sha256.create());

    const certificatePem = forge.pki.certificateToPem(certificate);
    const x509 = new X509Certificate(certificatePem);
    const caX509 = new X509Certificate(params.caCertPem);
    if (x509.issuer !== caX509.subject || !x509.verify(caX509.publicKey)) {
      throw AppError.internal('Issued certificate failed CA verification');
    }

    return {
      certificatePem,
      serialNumber: x509.serialNumber,
      fingerprint256: x509.fingerprint256 ?? x509.fingerprint,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw AppError.internal('Failed to issue a device certificate from the CSR');
  }
}
