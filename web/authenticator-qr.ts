import QRCode from 'qrcode';

// Encoded locally in the browser; the secret is never sent to a QR service.
export async function authenticatorQr(secret: string, email: string) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw Error('Chave do autenticador inválida.');
  const issuer = 'Blackout Create';
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  const uri = `otpauth://totp/${encodeURIComponent(issuer + ':' + email)}?${parameters}`;
  return QRCode.toDataURL(uri, {
    width: 256,
    margin: 4,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}
