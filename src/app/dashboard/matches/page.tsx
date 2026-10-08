import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getMatches } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function MatchesPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const matches = orgId ? await getMatches(orgId) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matches ({matches.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Listing</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Requirement</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Buyer interested?</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono">{m.listing.code} — {m.listing.product}</TableCell>
                <TableCell>{m.listing.sellerParty.name ?? "—"}</TableCell>
                <TableCell>{m.requirement.product}</TableCell>
                <TableCell>{m.requirement.buyerParty.name ?? "—"}</TableCell>
                <TableCell>{m.buyerInterestedAt ? <Badge>Yes</Badge> : <Badge variant="outline">Not yet</Badge>}</TableCell>
                <TableCell>{m.createdAt.toLocaleDateString()}</TableCell>
              </TableRow>
            ))}
            {matches.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Koi match nahi hai.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
