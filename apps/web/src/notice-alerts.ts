import type { OfficeEvent } from "@ai-office/events/schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Browser notifications for action Notices (PRD FR-51): each new action
// Notice shows a notification with a short sound, while info Notices are
// silent. The Owner turns them on in Admin, which is when the browser asks
// for permission (never on load), and can mute the sound or turn them off.
// The settings belong to this browser, as its permission does.

export interface NoticeAlertSettings {
  /** Whether action Notices show a browser notification. */
  readonly notify: boolean;
  /** Whether that notification plays a sound. */
  readonly sound: boolean;
}

export const useNoticeAlertSettings = create<
  NoticeAlertSettings & {
    readonly setNotify: (notify: boolean) => void;
    readonly setSound: (sound: boolean) => void;
  }
>()(
  persist(
    (set) => ({
      notify: false,
      sound: true,
      setNotify: (notify) => {
        set({ notify });
      },
      setSound: (sound) => {
        set({ sound });
      },
    }),
    {
      name: "ai-office:notice-alerts",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ notify, sound }) => ({ notify, sound }),
    },
  ),
);

/** Whether this browser may show notifications, or cannot at all. */
export type NotificationAccess = NotificationPermission | "unsupported";

/** A notification on screen. */
export interface ShownNotification {
  onclick: ((event: Event) => void) | null;
  close(): void;
}

/** The browser's notifications; tests replace them. */
export const browserNotifications = {
  access(): NotificationAccess {
    return "Notification" in globalThis
      ? Notification.permission
      : "unsupported";
  },
  /** Asks the Owner; only ever called from a click on the settings toggle. */
  async request(): Promise<NotificationAccess> {
    return "Notification" in globalThis
      ? Notification.requestPermission()
      : "unsupported";
  },
  show(title: string, options: NotificationOptions): ShownNotification {
    return new Notification(title, options);
  },
};

let audio: AudioContext | undefined;

/** The short sound an action Notice plays; tests replace it. */
export const noticeSound = {
  /**
   * Lets the page play sound. Browsers allow it only after the Owner has
   * interacted with the page, so this is called on their clicks and keys.
   */
  unlock(): void {
    if (!("AudioContext" in globalThis)) {
      return;
    }
    audio ??= new AudioContext();
    if (audio.state === "suspended") {
      void audio.resume().catch(() => undefined);
    }
  },
  /** Two soft rising tones, about half a second in all. */
  play(): void {
    if (audio?.state !== "running") {
      return;
    }
    const start = audio.currentTime;
    [660, 880].forEach((frequency, index) => {
      if (audio === undefined) {
        return;
      }
      const at = start + index * 0.18;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.32);
    });
  },
};

/** What a new event should do: notify (with or without sound), or nothing. */
export type NoticeAlert =
  | { readonly notify: false }
  | {
      readonly notify: true;
      readonly sound: boolean;
      readonly noticeId: string;
      readonly title: string;
      readonly body: string;
    };

/**
 * Only a newly raised action Notice notifies, and only when the Owner
 * turned notifications on and the browser allows them; it plays the sound
 * unless the Owner muted it. Info Notices never notify.
 */
export function noticeAlert(
  event: OfficeEvent,
  settings: NoticeAlertSettings,
  access: NotificationAccess,
  /** A Floor's name as the Owner chose it, or its id when unknown. */
  floorName: (floorId: string) => string = (floorId) => floorId,
): NoticeAlert {
  if (
    event.type !== "notice.raised" ||
    event.kind !== "action" ||
    !settings.notify ||
    access !== "granted"
  ) {
    return { notify: false };
  }
  return {
    notify: true,
    sound: settings.sound,
    noticeId: event.noticeId,
    title: event.title,
    body:
      event.floorId === undefined
        ? "Needs your action."
        : `Needs your action on ${floorName(event.floorId)}.`,
  };
}
