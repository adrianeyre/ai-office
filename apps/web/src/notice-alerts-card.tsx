import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import {
  browserNotifications,
  noticeSound,
  useNoticeAlertSettings,
  type NotificationAccess,
} from "./notice-alerts.ts";

const checkboxClass = "size-4 accent-primary disabled:opacity-50";

const refusal: Record<Exclude<NotificationAccess, "granted">, string> = {
  denied:
    "This browser blocks notifications from AI Office. Allow them in its settings for this site, then turn this on again.",
  default:
    "The browser was not given permission to show notifications, so they stay off.",
  unsupported: "This browser cannot show notifications.",
};

/**
 * Browser notifications for action Notices (PRD FR-51), for this browser.
 * Turning them on is what asks the browser for permission.
 */
export function NoticeAlertsCard() {
  const notify = useNoticeAlertSettings((settings) => settings.notify);
  const sound = useNoticeAlertSettings((settings) => settings.sound);
  const setNotify = useNoticeAlertSettings((settings) => settings.setNotify);
  const setSound = useNoticeAlertSettings((settings) => settings.setSound);
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  const access = browserNotifications.access();

  const turnOn = async () => {
    // A click: the moment browsers allow sound to start.
    noticeSound.unlock();
    setProblem(undefined);
    setAsking(true);
    const answer =
      access === "granted" ? access : await browserNotifications.request();
    setAsking(false);
    if (answer === "granted") {
      setNotify(true);
    } else {
      setProblem(refusal[answer]);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Browser notifications</h2>
        </CardTitle>
        <CardDescription>
          Each new action Notice shows a notification from this browser, with a
          short sound; clicking it opens the Notice. Info Notices stay on the
          Notice Board, silently.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            id="notice-alerts-notify"
            type="checkbox"
            className={checkboxClass}
            checked={notify}
            disabled={asking}
            onChange={(event) => {
              if (event.target.checked) {
                void turnOn();
              } else {
                setProblem(undefined);
                setNotify(false);
              }
            }}
          />
          <label htmlFor="notice-alerts-notify" className="text-sm">
            Notify me of action Notices
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="notice-alerts-sound"
            type="checkbox"
            className={checkboxClass}
            checked={sound}
            disabled={!notify}
            onChange={(event) => {
              setSound(event.target.checked);
            }}
          />
          <label htmlFor="notice-alerts-sound" className="text-sm">
            Play a sound
          </label>
        </div>
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {problem === undefined && notify && access !== "granted" && (
          <p role="status" className="text-sm text-muted-foreground">
            {access === "unsupported"
              ? refusal.unsupported
              : "Notifications are on here, but the browser no longer allows them. Allow them in its settings for this site."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
