onClipEvent(load){
   _root.fade_sound = null;
   _root.next_sound = 1;
   if(!sound_mov1)
   {
      _root.attachMovie("blank","sound_mov1",1);
      _root.attachMovie("blank","sound_mov2",2);
      _root.attachMovie("blank","sound_background",3);
   }
   _root.background_sound = "loop";
   _root.ramp_sound = true;
   _root.start_background = true;
}
