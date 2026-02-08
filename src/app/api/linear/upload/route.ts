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

  const { uploadUrl, assetUrl } = gqlData.data.fileUpload.uploadFile;

  // Step 2: PUT the file to the signed URL
  const fileBuffer = await file.arrayBuffer();
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000',
    },
    body: fileBuffer,
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    return NextResponse.json({ error: `Upload PUT failed: ${err}` }, { status: 500 });
  }

  return NextResponse.json({ assetUrl });
}
