// SigV4 against AWS's own signing test suite (aws-c-auth's
// `aws-signing-test-suite/v4`): the same credentials, time, region and
// service, and the signatures AWS publishes for them.
import { describe, expect, it } from "vitest";

import { amzDate, signAwsRequest } from "./aws-sigv4.ts";

const key = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const sessionToken =
  "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";
const now = new Date("2015-08-30T12:36:00Z");
const options = { key, region: "us-east-1", service: "service", now };
const credential =
  "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";

describe("signAwsRequest", () => {
  it.each([
    {
      vector: "get-vanilla",
      request: { method: "GET", url: "https://example.amazonaws.com/" },
      signedHeaders: "host;x-amz-date",
      signature:
        "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      vector: "post-vanilla",
      request: { method: "POST", url: "https://example.amazonaws.com/" },
      signedHeaders: "host;x-amz-date",
      signature:
        "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    },
    {
      vector: "get-vanilla-query-order-key-case",
      request: {
        method: "GET",
        url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      },
      signedHeaders: "host;x-amz-date",
      signature:
        "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    },
    {
      vector: "post-x-www-form-urlencoded",
      request: {
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "13",
          "x-amz-content-sha256":
            "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
        },
        body: "Param1=value1",
      },
      signedHeaders:
        "content-length;content-type;host;x-amz-content-sha256;x-amz-date",
      signature:
        "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    },
  ])(
    "signs AWS's $vector as AWS does",
    ({ request, signedHeaders, signature }) => {
      expect(signAwsRequest({ body: "", ...request }, options)).toEqual({
        "x-amz-date": "20150830T123600Z",
        authorization: `${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      });
    },
  );

  it("signs a temporary key's session token too (post-sts-header-before)", () => {
    expect(
      signAwsRequest(
        { method: "POST", url: "https://example.amazonaws.com/", body: "" },
        { ...options, key: { ...key, sessionToken } },
      ),
    ).toEqual({
      "x-amz-date": "20150830T123600Z",
      "x-amz-security-token": sessionToken,
      authorization: `${credential}, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead`,
    });
  });

  it("signs the body, the host (with its port) and the path", () => {
    const sign = (url: string, body: string) =>
      signAwsRequest({ method: "POST", url, body }, options).authorization;
    const base = sign(
      "https://example.amazonaws.com/anthropic/v1/messages",
      "{}",
    );
    expect(
      sign("https://example.amazonaws.com/anthropic/v1/messages", "{ }"),
    ).not.toBe(base);
    expect(
      sign("https://example.amazonaws.com:8443/anthropic/v1/messages", "{}"),
    ).not.toBe(base);
    expect(
      sign(
        "https://example.amazonaws.com/anthropic/v1/messages/count_tokens",
        "{}",
      ),
    ).not.toBe(base);
  });

  it("writes the time as AWS does", () => {
    expect(amzDate(new Date("2026-10-10T09:05:07.123Z"))).toBe(
      "20261010T090507Z",
    );
  });
});
