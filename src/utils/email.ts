type SendVerificationEmailParams = {
  to: string;
  name: string;
  token: string;
};

function getVerificationUrl(token: string) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return `${frontendUrl}/verify-email?token=${token}`;
}

export async function sendVerificationEmail({
  to,
  name,
  token,
}: SendVerificationEmailParams) {
  const verificationUrl = getVerificationUrl(token);

  console.log("\n================ VERIFICAÇÃO DE EMAIL ================");
  console.log(`Nome: ${name}`);
  console.log(`Email: ${to}`);
  console.log(`Link: ${verificationUrl}`);
  console.log("======================================================\n");

  return {
    sent: false,
    verificationUrl,
  };
}