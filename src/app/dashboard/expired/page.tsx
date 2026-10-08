import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ExpiredPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Link expire ho gaya</CardTitle>
          <CardDescription>
            Ye dashboard link expire ho chuka hai ya already use ho chuka hai. WhatsApp par bot ko
            &quot;dashboard&quot; likh kar naya link mangwa lijiye.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
