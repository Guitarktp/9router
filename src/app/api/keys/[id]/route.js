import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import {
  ActiveProviderValidationError,
  intersectApiKeysWithCurrentCatalog,
  normalizeActiveProviderInput,
} from "@/lib/apiKeyProviderCatalog";
import {
  ActiveConnectionValidationError,
  intersectApiKeysWithCurrentConnections,
  normalizeActiveConnectionInput,
} from "@/lib/apiKeyConnectionPolicy";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const storedKey = await getApiKeyById(id);
    if (!storedKey) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const catalogKeys = await intersectApiKeysWithCurrentCatalog([storedKey]);
    const [key] = await intersectApiKeysWithCurrentConnections(catalogKeys);
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (Object.hasOwn(body, "activeProviders")) {
      updateData.activeProviders = await normalizeActiveProviderInput(body.activeProviders);
    }
    if (Object.hasOwn(body, "activeConnections")) {
      updateData.activeConnections = await normalizeActiveConnectionInput(
        body.activeConnections,
        existing.activeConnections,
      );
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    if (error instanceof ActiveProviderValidationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    if (error instanceof ActiveConnectionValidationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
