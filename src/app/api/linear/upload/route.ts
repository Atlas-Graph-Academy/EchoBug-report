import { NextRequest, NextResponse } from 'next/server';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const accessToken = formData.get('access_token') as string | null;

  if (!file || !accessToken) {
    return NextResponse.json({ error: 'Missing file or access_token' }, { status: 400 });
  }

  // Step 1: Get a signed upload URL from Linear
  const uploadQuery = `
    mutation($filename: String!, $contentType: String!, $size: Int!) {
      fileUpload(filename: $filename, contentType: $contentType, size: $size) {
        success
        uploadFile {
          filename
          contentType
          size
          uploadUrl
          assetUrl
          headers {
            key
            value
          }
        }
      }
    }
  `;

  const gqlRes = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: uploadQuery,
      variables: {
        filename: file.name,
        contentType: file.type || 'image/jpeg',
        size: file.size,
      },
    }),
  });

  if (!gqlRes.ok) {
    const err = await gqlRes.text();
    return NextResponse.json({ error: `GraphQL failed: ${err}` }, { status: 500 });
  }

  const gqlData = await gqlRes.json();
  if (gqlData.errors) {
    return NextResponse.json({ error: gqlData.errors[0]?.message }, { status: 500 });
  }

  const { uploadUrl, assetUrl, headers: uploadHeaders } = gqlData.data.fileUpload.uploadFile;

  // Step 2: PUT the file to the signed URL with required headers
  const fileBuffer = await file.arrayBuffer();
  const putHeaders: Record<string, string> = {
    'Content-Type': file.type || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000',
  };

  // Include headers returned by Linear (e.g. x-goog-content-length-range)
  if (Array.isArray(uploadHeaders)) {
    for (const h of uploadHeaders) {
      putHeaders[h.key] = h.value;
    }
  }

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: fileBuffer,
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    return NextResponse.json({ error: `Upload PUT failed: ${err}` }, { status: 500 });
  }

  return NextResponse.json({ assetUrl });
}
