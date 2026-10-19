#ifndef FORGEDESK_BUILD_ID_H
#define FORGEDESK_BUILD_ID_H

/* The trusted build wrapper replaces these bytes before compilation.
 * An unbound build deliberately returns an all-zero ID and fails verification. */
#ifndef FORGEDESK_BUILD_ID_BYTES
#define FORGEDESK_BUILD_ID_BYTES { \
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, \
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 }
#endif

#endif
