"""Bounded lossless uploaded-frame source, compatible with board Python 3.6."""
import collections
import threading
import time
from .image_boundary import (checked_job_id, validate_upload_frame,
                             validate_upload_metadata)

class UploadSource:
    def __init__(self,job_id,capacity=16):
        checked_job_id(job_id)
        if type(capacity) is not int or not 1 <= capacity <= 16:
            raise ValueError('upload capacity must be within 1..16 frames')
        self.job_id=job_id;self.capacity=capacity
        self.frames=collections.deque();self.condition=threading.Condition()
        self.received=0;self.completed=0;self.last_time=-1.0
        self.finished=False;self.cancelled=False;self.error=None
    def put(self,meta,jpeg):
        clean = validate_upload_metadata(meta, self.job_id)
        with self.condition:
            self._check_admission(clean)
        clean, data = validate_upload_frame(clean, jpeg, self.job_id)
        with self.condition:
            self._check_admission(clean)
            frame=dict(clean,jpeg=data,capture_monotonic=time.monotonic(),source='upload',job_id=self.job_id)
            self.frames.append(frame);self.received+=1;self.last_time=clean['video_time_s'];self.condition.notify_all()
            return dict(frame)
    def _check_admission(self,meta):
        if self.cancelled or self.finished:raise ValueError('upload job is closed')
        if meta['frame_id']!=self.received:raise ValueError('uploaded frames must be consecutive from zero')
        if meta['video_time_s']<self.last_time:raise ValueError('source video timestamp must be monotonic')
        if len(self.frames)>=self.capacity:raise ValueError('upload queue full; wait for result credits')
    def take(self,timeout=.2):
        with self.condition:
            if not self.frames and not self.finished and not self.cancelled:self.condition.wait(timeout)
            return self.frames.popleft() if self.frames and not self.cancelled else None
    def push_back(self,frame):
        with self.condition:
            if not self.cancelled:self.frames.appendleft(frame);self.condition.notify_all()
    def finish(self,count):
        with self.condition:
            if type(count) is not int or count!=self.received:raise ValueError('upload final frame count mismatch')
            self.finished=True;self.condition.notify_all()
    def cancel(self):
        with self.condition:self.cancelled=True;self.frames.clear();self.condition.notify_all()
    @property
    def exhausted(self):
        with self.condition:return self.finished and not self.frames
    def status(self):
        with self.condition:return dict(job_id=self.job_id,received=self.received,completed=self.completed,queued=len(self.frames),finished=self.finished,cancelled=self.cancelled,error=self.error)
