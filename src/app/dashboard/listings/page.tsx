import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getListings } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function ListingsPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const listings = orgId ? await getListings(orgId) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Listings ({listings.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listings.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-mono">{l.code}</TableCell>
                <TableCell>{l.product}</TableCell>
                <TableCell>{l.quantity ? `${l.quantity} ${l.unit ?? ""}` : "—"}</TableCell>
                <TableCell>{l.pricePerUnit ? `₹${l.pricePerUnit}` : "—"}</TableCell>
                <TableCell>{l.location ?? "—"}</TableCell>
                <TableCell>{l.sellerParty.name ?? l.sellerParty.contact.waPhone}</TableCell>
                <TableCell><Badge variant="outline">{l.status}</Badge></TableCell>
              </TableRow>
            ))}
            {listings.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Koi listing nahi hai.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
