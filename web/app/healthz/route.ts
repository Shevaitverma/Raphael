import { NextResponse } from "next/server";

// Liveness probe for the web service. Static — does not depend on the gateway.
export function GET() {
  return NextResponse.json({ status: "ok" });
}
