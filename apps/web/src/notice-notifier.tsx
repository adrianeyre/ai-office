import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useEventStream } from "./event-stream.ts";
import { floorsQuery } from "./floors.ts";
import {
  browserNotifications,
  noticeAlert,
  noticeSound,
  useNoticeAlertSettings,
} from "./notice-alerts.ts";

// Shows a browser notification, with a sound, for each new action Notice
// (PRD FR-51), on every page of the app. Clicking one brings AI Office
// forward on that Notice.

function NotifyingStream() {
  const navigate = useNavigate();

  // Browsers play sound only after the Owner has interacted with the page.
  useEffect(() => {
    const unlock = () => {
      noticeSound.unlock();
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  useEventStream(
    { types: ["notice.raised"] },
    {
      onEvent: ({ event }, client) => {
        const alert = noticeAlert(
          event,
          useNoticeAlertSettings.getState(),
          browserNotifications.access(),
          (floorId) =>
            client
              .getQueryData(floorsQuery.queryKey)
              ?.find(({ id }) => id === floorId)?.name ?? floorId,
        );
        if (!alert.notify) {
          return;
        }
        const notification = browserNotifications.show(alert.title, {
          body: alert.body,
          // One notification per Notice, however many tabs are open.
          tag: alert.noticeId,
          // The sound is AI Office's own, and the Owner may mute it.
          silent: true,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          void navigate({
            to: "/notices",
            search: { notice: alert.noticeId },
          });
        };
        if (alert.sound) {
          noticeSound.play();
        }
      },
    },
  );
  return null;
}

/** Listens for action Notices while the Owner has notifications on. */
export function NoticeNotifier() {
  const notify = useNoticeAlertSettings((settings) => settings.notify);
  return notify ? <NotifyingStream /> : null;
}
