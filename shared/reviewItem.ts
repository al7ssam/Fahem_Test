/** عنصر مراجعة سؤال واحد: السؤال، الخيارات، الإجابة الصحيحة، إجابة اللاعب، والمادة الدراسية */
export type ReviewItem = {
  questionId: number;
  choiceIndex: number | null; // null = لم يجب
  correctIndex: number;
  prompt: string;
  options: string[];
  studyBody: string | null;
};
