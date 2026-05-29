// YouTube "is this the right video?" feedback modal, extracted from App.tsx.
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconYoutube } from "../Icons";

interface YoutubeFeedbackModalProps {
  url: string;
  videoTitle: string;
  onRespond: (save: boolean) => void;
}

export function YoutubeFeedbackModal({ url, videoTitle, onRespond }: YoutubeFeedbackModalProps) {
  return (
    <div className="youtube-modal-overlay" onClick={() => onRespond(false)}>
      <div className="youtube-modal" onClick={(e) => e.stopPropagation()}>
        <div className="youtube-modal-icon"><IconYoutube size={24} /></div>
        <div className="youtube-modal-text">
          Is this the right video for "<strong>{videoTitle}</strong>"?<br />
          Save this link for future use?
        </div>
        <a className="youtube-modal-link" onClick={() => openUrl(url)}>{url}</a>
        <div className="youtube-modal-actions">
          <button className="youtube-modal-btn" onClick={() => onRespond(false)}>No</button>
          <button className="youtube-modal-btn yes" onClick={() => onRespond(true)}>Yes</button>
        </div>
      </div>
    </div>
  );
}
