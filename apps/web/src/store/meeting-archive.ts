import { ONLINE_SERVICE_URL } from '../config.js';
import { MeetingArchiveClient } from './meeting-archive-client.js';

/** No I/O until App explicitly initializes/starts the local archive. */
export const meetingArchive = new MeetingArchiveClient({ baseUrl: ONLINE_SERVICE_URL });
