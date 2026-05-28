// tests/unit/components/upload-drawer-path.test.tsx
//
// Spec for Task 16: UploadDrawer renders a path-prefix line above the
// filename when displayPath has a directory component; nothing extra
// for root-level files.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { UploadDrawer } from "@/components/features/upload/upload-drawer";

describe("UploadDrawer (Task 16) — displayPath prefix", () => {
  it("renders the parent-path prefix above the filename for folder uploads", () => {
    render(
      <UploadDrawer
        tasks={[
          {
            id: "t1",
            filename: "q1.pdf",
            displayPath: "logs/2025/q1.pdf",
            bytes: 100,
            uploaded: 50,
            speed: 10,
            status: "uploading",
          },
        ]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        onClearDone={vi.fn()}
      />,
    );
    expect(screen.getByText("logs/2025/")).toBeInTheDocument();
    expect(screen.getByText("q1.pdf")).toBeInTheDocument();
  });

  it("does not render a path prefix for root-level files", () => {
    render(
      <UploadDrawer
        tasks={[
          {
            id: "t1",
            filename: "a.txt",
            displayPath: "a.txt",
            bytes: 100,
            uploaded: 50,
            speed: 10,
            status: "uploading",
          },
        ]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        onClearDone={vi.fn()}
      />,
    );
    // No element should contain a trailing '/' for the filename row.
    expect(screen.queryByText("a.txt/")).not.toBeInTheDocument();
  });
});
