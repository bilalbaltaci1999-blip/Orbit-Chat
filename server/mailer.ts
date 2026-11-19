/** E-posta gönderimi (SMTP). SMTP_URL tanımlı değilse gönderim yapılmaz. */
import nodemailer from 'nodemailer';

type Transporter = ReturnType<typeof nodemailer.createTransport>;

let transport: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL);
}

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport(process.env.SMTP_URL as string);
  }
  return transport;
}

export async function sendMail(input: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!mailConfigured()) return false;
  await getTransport().sendMail({
    from: process.env.MAIL_FROM ?? 'ORBIT <no-reply@orbit.app>',
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return true;
}
