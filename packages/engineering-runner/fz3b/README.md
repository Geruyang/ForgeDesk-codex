# Fixed FZ3B status probe

`probeFz3bClaimedStatus` connects only to `169.254.220.254:8765` and sends only
FZVA `hello` and `status`. It observes the first matching status ACK and closes
the connection. Bytes following that ACK, even in the same TCP packet, are not
validated; this is not an authentication or validation of the whole stream.

The hello exchange has no peer authentication. Matching platform, boot ID, and
contract fields are application claims, not proof of the board, PL image, or
inference computation. The status call can send R5 telemetry, and closing the
control connection can stop camera inference if it was the last subscriber.
Callers must acknowledge that disconnect effect before probing.
