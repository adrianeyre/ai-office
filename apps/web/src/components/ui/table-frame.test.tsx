import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TableFrame } from "./table-frame.tsx";

afterEach(cleanup);

describe("TableFrame", () => {
  it("holds its table in a named region the keyboard can scroll", () => {
    render(
      <TableFrame label="Roles, scrollable">
        <table aria-label="Roles">
          <tbody>
            <tr>
              <td>coder</td>
            </tr>
          </tbody>
        </table>
      </TableFrame>,
    );
    const frame = screen.getByRole("region", { name: "Roles, scrollable" });
    expect(frame.tabIndex).toBe(0);
    expect(frame.className).toContain("overflow-x-auto");
    expect(within(frame).getByRole("table", { name: "Roles" })).toBeTruthy();
  });
});
