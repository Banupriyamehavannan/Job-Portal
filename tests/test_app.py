import os
import tempfile
import unittest
from datetime import datetime
from io import BytesIO
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["SECRET_KEY"] = "job-portal-tests-only"

import app as portal
from app import (
    JobApplication,
    JobPost,
    SavedJob,
    User,
    create_application_token,
    db,
    get_application_job,
    local_date_filter_bounds,
    safe_redirect_target,
    validate_application_upload,
)
from werkzeug.datastructures import FileStorage
from werkzeug.exceptions import BadRequest
from werkzeug.security import generate_password_hash


class JobPortalTests(unittest.TestCase):
    def setUp(self):
        portal.app.config.update(TESTING=True, SECRET_KEY="job-portal-tests-only")
        self.client = portal.app.test_client()
        self.upload_directory = tempfile.TemporaryDirectory()
        self.previous_upload_folder = portal.APPLICATION_UPLOAD_FOLDER
        portal.APPLICATION_UPLOAD_FOLDER = self.upload_directory.name
        with portal.app.app_context():
            db.session.remove()
            db.drop_all()
            db.create_all()
            self.seeker = User(
                name="Job Seeker",
                email="seeker@example.com",
                password=generate_password_hash("password123"),
                role="job_seeker",
            )
            self.employer = User(
                name="Employer",
                email="employer@example.com",
                password=generate_password_hash("password123"),
                role="employer",
            )
            db.session.add_all((self.seeker, self.employer))
            db.session.flush()
            self.job = JobPost(
                employer_id=self.employer.id,
                title="Software Engineer",
                company="Example Co",
                location="Chennai",
                employment_type="Full-time",
                experience_level="Mid-level",
                skills="Python",
                requirements="Build reliable software",
                description="Work with our engineering team.",
                application_url="",
            )
            db.session.add(self.job)
            db.session.commit()
            self.seeker_id = self.seeker.id
            self.employer_id = self.employer.id
            self.job_id = self.job.id

    def tearDown(self):
        with portal.app.app_context():
            db.session.remove()
            db.engine.dispose()
        portal.APPLICATION_UPLOAD_FOLDER = self.previous_upload_folder
        self.upload_directory.cleanup()

    def log_in_as(self, user_id):
        with self.client.session_transaction() as browser_session:
            browser_session["_user_id"] = str(user_id)
            browser_session["_fresh"] = True

    def csrf_token(self, page="/login"):
        response = self.client.get(page)
        self.assertEqual(response.status_code, 200)
        with self.client.session_transaction() as browser_session:
            return browser_session["_application_csrf_token"]

    def test_home_page_loads_for_anonymous_users(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)

    def test_jobs_page_renders_local_jobs_when_external_feed_is_empty(self):
        with patch.object(portal, "get_himalayas_jobs", return_value=([], "", None)):
            response = self.client.get("/jobs")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Software Engineer", response.data)
        self.assertIn(b"Example Co", response.data)

    def test_login_requires_csrf_token(self):
        response = self.client.post(
            "/login",
            data={"email": "seeker@example.com", "password": "password123"},
        )
        self.assertEqual(response.status_code, 400)

    def test_logout_requires_a_csrf_protected_post(self):
        self.log_in_as(self.seeker_id)
        confirmation = self.client.get("/logout")
        self.assertEqual(confirmation.status_code, 200)
        token = self.csrf_token("/logout")
        response = self.client.post(
            "/logout",
            data={"_csrf_token": token, "next": "/jobs"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/jobs"))
        self.assertEqual(self.client.get("/employer/manage-jobs").status_code, 302)

    def test_login_accepts_valid_credentials_and_csrf_token(self):
        token = self.csrf_token()
        response = self.client.post(
            "/login",
            data={
                "_csrf_token": token,
                "email": "seeker@example.com",
                "password": "password123",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/jobs"))

    def test_registration_requires_csrf_token(self):
        response = self.client.post(
            "/register",
            data={
                "name": "New User",
                "email": "new@example.com",
                "password": "password123",
                "role": "job_seeker",
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_registration_rejects_invalid_email(self):
        token = self.csrf_token("/register")
        response = self.client.post(
            "/register",
            data={
                "_csrf_token": token,
                "name": "New User",
                "email": "not-an-email",
                "password": "password123",
                "role": "job_seeker",
            },
        )
        self.assertEqual(response.status_code, 200)
        with portal.app.app_context():
            self.assertIsNone(User.query.filter_by(email="not-an-email").first())

    def test_registration_creates_job_seeker(self):
        token = self.csrf_token("/register")
        response = self.client.post(
            "/register",
            data={
                "_csrf_token": token,
                "name": "New User",
                "email": "new@example.com",
                "password": "password123",
                "role": "job_seeker",
            },
        )
        self.assertEqual(response.status_code, 302)
        with portal.app.app_context():
            user = User.query.filter_by(email="new@example.com").one()
            self.assertEqual(user.role, "job_seeker")

    def test_job_seeker_cannot_access_employer_tools(self):
        self.log_in_as(self.seeker_id)
        for path in (
            "/employer/post-job",
            "/employer/manage-jobs",
            "/employer/applications",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 403)

    def test_employer_can_view_owned_job(self):
        self.log_in_as(self.employer_id)
        response = self.client.get("/employer/manage-jobs")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Software Engineer", response.data)

    def test_employer_can_update_an_owned_application(self):
        with portal.app.app_context():
            application = JobApplication(
                user_id=self.seeker_id,
                portal_job_id=self.job_id,
                job_key="application-test-key",
                job_title="Software Engineer",
                company="Example Co",
                source_url="https://example.com/jobs/software-engineer",
                applicant_name="Job Seeker",
                applicant_email="seeker@example.com",
                phone="555-0100",
                cover_letter="",
                resume_filename="resume.pdf",
                resume_original_name="resume.pdf",
            )
            db.session.add(application)
            db.session.commit()
            application_id = application.id

        self.log_in_as(self.employer_id)
        token = self.csrf_token("/employer/applications")
        with patch.object(portal, "notify_applicant_status", return_value="not_configured"):
            response = self.client.post(
                f"/employer/applications/{application_id}/status",
                data={"_csrf_token": token, "status": "accepted"},
            )
        self.assertEqual(response.status_code, 302)
        with portal.app.app_context():
            self.assertEqual(
                db.session.get(JobApplication, application_id).status,
                "accepted",
            )

    def test_employer_cannot_edit_another_employers_job(self):
        with portal.app.app_context():
            other_employer = User(
                name="Other Employer",
                email="other@example.com",
                password=generate_password_hash("password123"),
                role="employer",
            )
            db.session.add(other_employer)
            db.session.flush()
            other_job = JobPost(
                employer_id=other_employer.id,
                title="Private Role",
                company="Other Co",
                location="Remote",
                employment_type="Full-time",
                experience_level="Senior",
                skills="Python",
                requirements="Build software",
                description="A private role.",
                application_url="",
            )
            db.session.add(other_job)
            db.session.commit()
            other_job_id = other_job.id

        self.log_in_as(self.employer_id)
        response = self.client.get(f"/employer/jobs/{other_job_id}/edit")
        self.assertEqual(response.status_code, 404)

    def test_employer_posting_requires_csrf_token(self):
        self.log_in_as(self.employer_id)
        response = self.client.post("/employer/post-job", data={"title": "New role"})
        self.assertEqual(response.status_code, 400)

    def test_ai_job_description_api_requires_csrf_token(self):
        self.log_in_as(self.employer_id)
        with patch.object(portal, "GEMINI_API_KEY", "test-key"):
            response = self.client.post(
                "/api/employer/job-description",
                json={
                    "title": "Engineer",
                    "requirements": "Build software",
                },
            )
        self.assertEqual(response.status_code, 400)

    def test_ai_assistant_api_requires_csrf_token(self):
        with patch.object(portal, "GEMINI_API_KEY", "test-key"):
            response = self.client.post(
                "/api/job-assistant",
                json={"message": "Find software jobs", "jobs": []},
            )
        self.assertEqual(response.status_code, 400)

    def test_job_seeker_can_save_a_local_job(self):
        self.log_in_as(self.seeker_id)
        token = self.csrf_token("/jobs")
        response = self.client.post(
            "/jobs/save",
            data={
                "_csrf_token": token,
                "action": "save",
                "job_id": str(self.job_id),
                "next": "/jobs",
            },
        )
        self.assertEqual(response.status_code, 302)
        with portal.app.app_context():
            saved_job = SavedJob.query.one()
            self.assertEqual(saved_job.job_title, "Software Engineer")
            self.assertEqual(saved_job.user_id, self.seeker_id)

    def test_job_seeker_can_submit_one_local_job_application(self):
        self.log_in_as(self.seeker_id)
        token = self.csrf_token(f"/jobs/portal/{self.job_id}/apply")
        with patch.object(portal, "notify_employer_application", return_value="not_configured"):
            response = self.client.post(
                f"/jobs/portal/{self.job_id}/apply",
                data={
                    "_csrf_token": token,
                    "name": "Job Seeker",
                    "email": "seeker@example.com",
                    "phone": "555-0100",
                    "cover_letter": "I am interested in this role.",
                    "resume_choice": "new",
                    "resume": (BytesIO(b"%PDF-1.7\nresume"), "resume.pdf"),
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/my-applications"))
        with portal.app.app_context():
            application = JobApplication.query.one()
            self.assertEqual(application.job_title, "Software Engineer")
            self.assertEqual(application.status, "submitted")
            self.assertEqual(
                db.session.get(User, self.seeker_id).resume_filename,
                application.resume_filename,
            )

    def test_safe_redirect_rejects_external_targets(self):
        with portal.app.test_request_context():
            self.assertEqual(safe_redirect_target("https://example.com"), "/jobs")
            self.assertEqual(safe_redirect_target("//example.com"), "/jobs")
            self.assertEqual(safe_redirect_target(r"/\\example.com"), "/jobs")
            self.assertEqual(safe_redirect_target("/saved-jobs"), "/saved-jobs")

    def test_application_token_round_trip_and_tamper_rejection(self):
        job = {
            "title": "Backend Engineer",
            "company": "Example Co",
            "source_url": "https://himalayas.app/jobs/backend-engineer",
            "application_link": "https://example.com/careers/backend",
            "location": "Remote",
            "type": "Full-time",
            "salary": "Not listed",
            "company_logo": "",
        }
        with portal.app.test_request_context():
            token = create_application_token(job)
            self.assertEqual(get_application_job(token)["title"], job["title"])
            self.assertIsNone(get_application_job(token + "tampered"))

    def test_upload_validation_checks_content_not_only_extension(self):
        valid_pdf = FileStorage(
            stream=BytesIO(b"%PDF-1.7\nexample"),
            filename="resume.pdf",
        )
        self.assertEqual(
            validate_application_upload(valid_pdf, {"pdf"}, "resume")["extension"],
            "pdf",
        )
        invalid_pdf = FileStorage(
            stream=BytesIO(b"not a pdf"),
            filename="resume.pdf",
        )
        with self.assertRaises(ValueError):
            validate_application_upload(invalid_pdf, {"pdf"}, "resume")

    def test_date_filter_converts_local_day_to_utc_bounds(self):
        with portal.app.app_context():
            start, end = local_date_filter_bounds("2025-01-02", "2025-01-02", "test")
        self.assertEqual(start, datetime(2025, 1, 1, 18, 30))
        self.assertEqual(end, datetime(2025, 1, 2, 18, 30))

    def test_date_filter_rejects_reversed_range(self):
        with self.assertRaises(BadRequest):
            local_date_filter_bounds("2025-01-03", "2025-01-02", "test")

    def test_session_cookie_uses_http_only_and_same_site(self):
        response = self.client.get("/login")
        cookie_headers = response.headers.getlist("Set-Cookie")
        self.assertTrue(any("HttpOnly" in header for header in cookie_headers))
        self.assertTrue(any("SameSite=Lax" in header for header in cookie_headers))


if __name__ == "__main__":
    unittest.main()
