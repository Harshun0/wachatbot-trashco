import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getRequirements } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function RequirementsPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const requirements = orgId ? await getRequirements(orgId) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Requirements ({requirements.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Max price</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requirements.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.product}</TableCell>
                <TableCell>{r.quantity ? `${r.quantity} ${r.unit ?? ""}` : "—"}</TableCell>
                <TableCell>{r.maxPrice ? `₹${r.maxPrice}` : "—"}</TableCell>
                <TableCell>{r.location ?? "—"}</TableCell>
                <TableCell>{r.buyerParty.name ?? r.buyerParty.contact.waPhone}</TableCell>
                <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
              </TableRow>
            ))}
            {requirements.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Koi requirement nahi hai.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
