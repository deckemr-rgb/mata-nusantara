import win32event
import win32api
import sys
from winerror import ERROR_ALREADY_EXISTS
mutex = win32event.CreateMutex (None, False, 'name')
last_error = win32api.GetLastError()
if last_error == ERROR_ALREADY_EXISTS:
 sys.exit(0)


import cv2
from ultralytics import YOLO

def detect_person_yolov8():
    # Load pretrained YOLOv8s model
    model = YOLO("yolov8n.pt")  # or 'yolov8s.pt' for more accuracy

    # Open webcam
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Webcam couldn't be opened.")
        return

    print("[INFO] Running YOLOv8 Person Detection. Press 'q' to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Run YOLOv8 inference
        results = model(frame, stream=True)

        person_count = 0
        for r in results:
            boxes = r.boxes
            for box in boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])
                # Only keep class 'person' (COCO class id 0)
                if cls == 0 and conf > 0.5:
                    person_count += 1
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(frame, f'Person {person_count}', (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

        cv2.putText(frame, f'Total Persons: {person_count}', (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 0, 0), 2)

        cv2.imshow("YOLOv8 Person Detection", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    print("[INFO] Detection complete.")

if __name__ == "__main__":
    detect_person_yolov8()