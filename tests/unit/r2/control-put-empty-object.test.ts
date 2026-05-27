import { describe, it, expect, vi } from "vitest";
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { putEmptyObject } from "@/lib/r2/control";
import { R2CredentialError, R2UpstreamError } from "@/lib/r2/errors";

function makeClient(sendImpl: (cmd: unknown) => unknown): S3Client {
  return { send: vi.fn(sendImpl) } as unknown as S3Client;
}

describe("putEmptyObject", () => {
  it("returns alreadyExisted=true when HeadObject 200", async () => {
    const client = makeClient(async (cmd) => {
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 0 };
      throw new Error("PutObject must not be called");
    });
    const result = await putEmptyObject({
      client,
      bucket: "b",
      key: "logs/",
    });
    expect(result.alreadyExisted).toBe(true);
  });

  it("writes 0-byte object when HeadObject 404", async () => {
    let putCalled = false;
    const client = makeClient(async (cmd) => {
      if (cmd instanceof HeadObjectCommand) {
        const err = new Error("NoSuchKey") as Error & {
          $metadata?: { httpStatusCode: number };
          name: string;
        };
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (cmd instanceof PutObjectCommand) {
        putCalled = true;
        return {};
      }
      throw new Error("unexpected command");
    });
    const result = await putEmptyObject({
      client,
      bucket: "b",
      key: "logs/",
    });
    expect(result.alreadyExisted).toBe(false);
    expect(putCalled).toBe(true);
  });

  it("maps 403 head to R2CredentialError", async () => {
    const client = makeClient(async () => {
      const err = new Error("AccessDenied") as Error & {
        $metadata?: { httpStatusCode: number };
        name: string;
      };
      err.name = "AccessDenied";
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    });
    await expect(
      putEmptyObject({ client, bucket: "b", key: "logs/" }),
    ).rejects.toBeInstanceOf(R2CredentialError);
  });

  it("maps 500 put to R2UpstreamError", async () => {
    const client = makeClient(async (cmd) => {
      if (cmd instanceof HeadObjectCommand) {
        const err = new Error("NotFound") as Error & {
          $metadata?: { httpStatusCode: number };
          name: string;
        };
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      const err = new Error("InternalError") as Error & {
        $metadata?: { httpStatusCode: number };
        name: string;
      };
      err.name = "InternalError";
      err.$metadata = { httpStatusCode: 500 };
      throw err;
    });
    await expect(
      putEmptyObject({ client, bucket: "b", key: "logs/" }),
    ).rejects.toBeInstanceOf(R2UpstreamError);
  });
});
