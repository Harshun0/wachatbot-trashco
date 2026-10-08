import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getParties } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function BuyersPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const buyers = orgId ? await getParties(orgId, "BUYER") : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Buyers ({buyers.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Alerts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {buyers.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.name ?? "—"}</TableCell>
                <TableCell>{b.city ?? "—"}</TableCell>
                <TableCell>{b.contact.waPhone}</TableCell>
                <TableCell>{b.alertPreference}</TableCell>
              </TableRow>
            ))}
            {buyers.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Koi buyer nahi hai.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
