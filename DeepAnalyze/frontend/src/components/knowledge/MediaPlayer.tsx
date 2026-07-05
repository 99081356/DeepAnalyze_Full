// =============================================================================
// DeepAnalyze - MediaPlayer
// Auto-detect media type and delegate to the correct preview component
// =============================================================================

import type { ImagePreviewProps } from "./ImagePreview";
import type { AudioPlayerProps } from "./AudioPlayer";
import type { VideoPlayerProps } from "./VideoPlayer";
import { ImagePreview } from "./ImagePreview";
import { AudioPlayer } from "./AudioPlayer";
import { VideoPlayer } from "./VideoPlayer";

export type MediaType = "image" | "audio" | "video";

export interface MediaPlayerProps {
  /** The type of media to display. */
  mediaType: MediaType;
  /** Props for image preview (required if mediaType is "image"). */
  imageProps?: ImagePreviewProps;
  /** Props for audio player (required if mediaType is "audio"). */
  audioProps?: AudioPlayerProps;
  /** Props for video player (required if mediaType is "video"). */
  videoProps?: VideoPlayerProps;
}

export function MediaPlayer({ mediaType, imageProps, audioProps, videoProps }: MediaPlayerProps) {
  switch (mediaType) {
    case "image":
      if (!imageProps) return null;
      return <ImagePreview {...imageProps} />;
    case "audio":
      if (!audioProps) return null;
      return <AudioPlayer {...audioProps} />;
    case "video":
      if (!videoProps) return null;
      return <VideoPlayer {...videoProps} />;
    default:
      return null;
  }
}
