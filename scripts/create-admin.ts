/**
 * One-off script to create (or reset the password of) an admin dashboard user.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/create-admin.ts you@example.com "Your Name" "a-strong-password"
 */
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

async function main() {
  const [email, name, password] = process.argv.slice(2);
  if (!email || !name || !password) {
    console.error('Usage: npx tsx --env-file=.env scripts/create-admin.ts <email> <name> <password>');
    process.exit(1);
  }

  const org = await prisma.organization.findFirst();
  if (!org) {
    console.error("No organization found — create one first.");
    process.exit(1);
  }

  const passwordHash = hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    create: { organizationId: org.id, email, name, role: "ADMIN", passwordHash },
    update: { passwordHash, name },
  });

  console.info(`Admin user ready: ${user.email} (role: ${user.role})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
